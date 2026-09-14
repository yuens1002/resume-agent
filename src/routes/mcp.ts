import '../lib/env.js'
import { createHash, randomUUID } from 'node:crypto'
import { timingSafeEqual } from '../lib/crypto.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { jwtVerify } from 'jose'
import { generateText, embed } from 'ai'
import { openrouter } from '../lib/ai.js'
import { supabase } from '../lib/supabase.js'
import { invalidateProfileCache } from '../lib/profile-cache.js'
import { parseJSON } from '../lib/parse-json.js'
import { scoreMatch, scoreMatchWithProvenance, type MatchScoreProvenance } from '../lib/score-match.js'
import { summarizeObservedQueries } from '../lib/summarize-observed-queries.js'
import { buildThoughtMetadata, resolveThoughtUpdateOpts } from '../lib/thought-metadata.js'
import { corsHeaders, checkOrigin } from '../lib/mcp-common.js'
import { mergePublication } from '../lib/publications.js'
import { registerJobPipelineFeed } from '../lib/job-pipeline-feed-tool.js'
import { registerApplicationEvidenceSnapshotTools } from '../lib/application-evidence-snapshot-tool.js'
import { APPLICATION_STAGES } from '../lib/application-evidence-snapshot.js'
import { registerApplicationResumeArtifactTool } from '../lib/application-resume-artifact-tool.js'
import type { Project, Publication } from '../types.js'

const OPEN_BRAIN_KEY = process.env.OPEN_BRAIN_KEY
const JWT_SECRET = process.env.JWT_SECRET
const jwtSecretBytes = JWT_SECRET ? new TextEncoder().encode(JWT_SECRET) : null

if (!OPEN_BRAIN_KEY) throw new Error('Missing OPEN_BRAIN_KEY')

// upsert_publication input schema — hoisted to module scope (unlike
// upsert_project's inline object literal) so it's a stable reference for
// tests and future reuse without re-allocating it on every buildServer() call.
const UPSERT_PUBLICATION_INPUT_SCHEMA = {
  slug:          z.string().describe('URL-safe identifier, e.g. "why-agentic-workflows-fail"'),
  title:         z.string().optional().describe('Display title of the piece'),
  platform:      z.string().optional().describe('Where it was published, e.g. "X", "Dev.to", "Medium", "YouTube"'),
  canonical_url: z.string().optional().describe('Canonical URL — the source-of-truth copy (POSSE)'),
  date:          z.string().optional().describe('Publish date, e.g. "2026-07-11"'),
  tags:          z.array(z.string()).optional().describe('Topic tags'),
  grounded_in:   z.string().optional().describe('Link back to the specific knowledge_base concept/finding the piece is based on'),
}

// ── Helpers ───────────────────────────────────────────────

async function getEmbedding(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openrouter.embedding('openai/text-embedding-3-small'),
    value: text,
  })
  return embedding
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  try {
    const { text: raw } = await generateText({
      model: openrouter('openai/gpt-4o-mini'),
      system: `Extract metadata from the user's captured thought. Respond ONLY with valid JSON — no prose, no markdown fences.
Return an object with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
      prompt: text,
    })
    return parseJSON<Record<string, unknown>>(raw)
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.error('extractMetadata failed; returning fallback metadata.', error)
    }
    return { topics: ['uncategorized'], type: 'observation' }
  }
}

// ── MCP Server ────────────────────────────────────────────

function buildServer(): McpServer {
  const server = new McpServer({ name: 'open-brain', version: '1.0.0' })
  registerJobPipelineFeed(server, (name, args) => supabase.rpc(name, args))
  registerApplicationEvidenceSnapshotTools(server, (name, args) => supabase.rpc(name, args))
  registerApplicationResumeArtifactTool(server, {
    readResume: async (applicationId, resumeId) => {
      const { data, error } = await supabase
        .from('application_resumes')
        .select('docx_url, docx_hash, pdf_url, pdf_hash')
        .eq('application_id', applicationId)
        .eq('id', resumeId)
        .maybeSingle()
      return { data, error }
    },
    download: async path => {
      const { data, error } = await supabase.storage.from('resume-artifacts').createSignedUrl(path, 60)
      if (error || !data?.signedUrl) return { data: null, error: error ?? new Error('missing signed artifact URL') }
      try {
        const response = await fetch(data.signedUrl)
        return response.ok && response.body
          ? { data: response.body, error: null }
          : { data: null, error: new Error(`artifact download failed with ${response.status}`) }
      } catch (downloadError) {
        return { data: null, error: downloadError }
      }
    },
  })

  // ── Thoughts Tools ────────────────────────────────────────

  server.registerTool(
    'search_thoughts',
    {
      title: 'Search Thoughts',
      description:
        'Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they\'ve previously captured.',
      inputSchema: {
        query: z.string().describe('What to search for'),
        limit: z.number().int().min(1).max(100).optional().default(10),
        threshold: z.number().min(0).max(1).optional().default(0.5),
      },
    },
    async ({ query, limit, threshold }) => {
      try {
        const qEmb = await getEmbedding(query)
        // match_thoughts_owner, not match_thoughts: this is the authenticated
        // owner-only surface and it must see private thoughts. Since #235 the
        // default RPC excludes them, so an unguarded read has to be named
        // explicitly — this call site is the only one that should do so.
        const { data, error } = await supabase.rpc('match_thoughts_owner', {
          query_embedding: qEmb,
          match_threshold: threshold,
          match_count: limit,
          filter: {},
        })

        if (error) {
          return { content: [{ type: 'text' as const, text: `Search error: ${error.message}` }], isError: true }
        }
        if (!data || data.length === 0) {
          return { content: [{ type: 'text' as const, text: `No thoughts found matching "${query}".` }] }
        }

        const results = data.map(
          (t: { id: string; content: string; metadata: Record<string, unknown>; similarity: number; created_at: string }, i: number) => {
            const m = t.metadata || {}
            const parts = [
              `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
              `ID: ${t.id}`,
              `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
              `Type: ${m.type || 'unknown'}`,
            ]
            if (Array.isArray(m.topics) && m.topics.length) parts.push(`Topics: ${(m.topics as string[]).join(', ')}`)
            if (Array.isArray(m.people) && m.people.length) parts.push(`People: ${(m.people as string[]).join(', ')}`)
            if (Array.isArray(m.action_items) && m.action_items.length) parts.push(`Actions: ${(m.action_items as string[]).join('; ')}`)
            parts.push(`\n${t.content}`)
            return parts.join('\n')
          }
        )

        return { content: [{ type: 'text' as const, text: `Found ${data.length} thought(s):\n\n${results.join('\n\n')}` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'record_application_observed_outcome',
    {
      title: 'Record Observed Application Outcome',
      description: 'Append a source-attributed email-only outcome observation. This never changes application stage and must not be inferred from stage.',
      inputSchema: {
        application_id: z.string().uuid(), source_identity: z.literal('granted_inbox'), source_event_id: z.string().min(1).max(512),
        revision: z.number().int().positive(), event_type: z.enum(['recruiter_contact', 'screen_scheduled', 'screen_held', 'interview_scheduled', 'interview_held', 'cancellation', 'rejection', 'withdrawal', 'offer', 'offer_accepted', 'job_started', 'other_response']),
        occurred_at: z.string().datetime({ offset: true }).optional(), source_ref: z.string().regex(/^imap:[a-f0-9]{64}:[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/), evidence_hash: z.string().regex(/^[a-f0-9]{64}$/),
        classification_code: z.enum(['automated_ack', 'explicit_email_content', 'ambiguous_email_content', 'unclassified']), action_required: z.boolean().optional(), supersedes_event_id: z.string().uuid().optional(),
      },
    },
    async (input) => {
      const { data, error } = await supabase.rpc('record_application_observed_outcome', {
        p_application_id: input.application_id, p_source_identity: input.source_identity, p_source_event_id: input.source_event_id, p_revision: input.revision,
        p_event_type: input.event_type, p_occurred_at: input.occurred_at ?? null, p_source_ref: input.source_ref, p_evidence_hash: input.evidence_hash,
        p_classification_code: input.classification_code, p_action_required: input.action_required ?? null, p_supersedes_event_id: input.supersedes_event_id ?? null,
      })
      return error || !data
        ? { content: [{ type: 'text' as const, text: 'Outcome observation was refused.' }], isError: true }
        : { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', outcome: data }) }] }
    },
  )

  server.registerTool(
    'record_application_outcome_check',
    {
      title: 'Record Application Outcome Coverage',
      description: 'Append email-only reader coverage. No-response requires a complete bounded, source-attested submission window; unknown never becomes an outcome.',
      inputSchema: {
        application_id: z.string().uuid(), reader_channel: z.literal('imap_inbox'), client_check_identity: z.string().min(1).max(512),
        period_start: z.string().datetime({ offset: true }), period_end: z.string().datetime({ offset: true }), query_scope: z.string().min(1).max(512),
        application_time_start: z.string().datetime({ offset: true }).optional(), complete: z.boolean(), status: z.enum(['observed', 'no_response', 'unknown']),
        matched_uid_count: z.number().int().nonnegative(), drained_uid_count: z.number().int().nonnegative(), source_ref: z.string().regex(/^imap-coverage:[a-f0-9]{64}:[1-9][0-9]{0,9}:[0-9]{1,13}:[0-9]{1,10}:[0-9]{1,10}$/),
      },
    },
    async (input) => {
      const { data, error } = await supabase.rpc('record_application_outcome_check', {
        p_application_id: input.application_id, p_reader_channel: input.reader_channel, p_client_check_identity: input.client_check_identity,
        p_period_start: input.period_start, p_period_end: input.period_end, p_query_scope: input.query_scope,
        p_application_time_start: input.application_time_start ?? null, p_complete: input.complete, p_status: input.status,
        p_matched_uid_count: input.matched_uid_count, p_drained_uid_count: input.drained_uid_count, p_source_ref: input.source_ref,
      })
      return error || !data
        ? { content: [{ type: 'text' as const, text: 'Outcome coverage was refused.' }], isError: true }
        : { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', outcome_check: data }) }] }
    },
  )

  server.registerTool(
    'list_thoughts',
    {
      title: 'List Recent Thoughts',
      description: 'List recently captured thoughts with optional filters by type, topic, person, or time range.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().default(10),
        type: z.string().optional().describe('Filter by type: observation, task, idea, reference, person_note'),
        topic: z.string().optional().describe('Filter by topic tag'),
        person: z.string().optional().describe('Filter by person mentioned'),
        days: z.number().int().min(1).max(365).optional().describe('Only thoughts from the last N days'),
      },
    },
    async ({ limit, type, topic, person, days }) => {
      try {
        const effectiveLimit = Math.min(limit ?? 10, 100)
        const effectiveDays = days != null ? Math.min(days, 365) : undefined

        let q = supabase
          .from('thoughts')
          .select('id, content, metadata, created_at')
          .order('created_at', { ascending: false })
          .limit(effectiveLimit)

        if (type) q = q.contains('metadata', { type })
        if (topic) q = q.contains('metadata', { topics: [topic] })
        if (person) q = q.contains('metadata', { people: [person] })
        if (effectiveDays != null) {
          const since = new Date()
          since.setDate(since.getDate() - effectiveDays)
          q = q.gte('created_at', since.toISOString())
        }

        const { data, error } = await q

        if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }], isError: true }
        if (!data || !data.length) return { content: [{ type: 'text' as const, text: 'No thoughts found.' }] }

        const results = data.map((t: { id: string; content: string; metadata: Record<string, unknown>; created_at: string }, i: number) => {
          const m = t.metadata || {}
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(', ') : ''
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || '??'}${tags ? ' - ' + tags : ''})\n   ${t.content}\n   ID: ${t.id}`
        })

        return { content: [{ type: 'text' as const, text: `${data.length} recent thought(s):\n\n${results.join('\n\n')}` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'thought_stats',
    {
      title: 'Thought Statistics',
      description: 'Get a summary of all captured thoughts: totals, types, top topics, and people.',
      inputSchema: {},
    },
    async () => {
      try {
        const { count, error: countError } = await supabase.from('thoughts').select('*', { count: 'exact', head: true })
        if (countError) return { content: [{ type: 'text' as const, text: `Error: ${countError.message}` }], isError: true }

        const { data, error: dataError } = await supabase
          .from('thoughts')
          .select('metadata, created_at')
          .order('created_at', { ascending: false })

        if (dataError) return { content: [{ type: 'text' as const, text: `Error: ${dataError.message}` }], isError: true }

        const types: Record<string, number> = {}
        const topics: Record<string, number> = {}
        const people: Record<string, number> = {}

        for (const r of data || []) {
          const m = (r.metadata || {}) as Record<string, unknown>
          if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1
          if (Array.isArray(m.topics)) for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1
          if (Array.isArray(m.people)) for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1
        }

        const sort = (o: Record<string, number>): [string, number][] =>
          Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10)

        const lines: string[] = [
          `Total thoughts: ${count}`,
          `Date range: ${data?.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() + ' → ' + new Date(data[0].created_at).toLocaleDateString()
            : 'N/A'}`,
          '',
          'Types:',
          ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
        ]

        if (Object.keys(topics).length) {
          lines.push('', 'Top topics:')
          for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`)
        }
        if (Object.keys(people).length) {
          lines.push('', 'People mentioned:')
          for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`)
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'summarize_observed_queries',
    {
      title: 'Summarize Public Query Traffic',
      description:
        'Get a summary of public query traffic hitting the /public-mcp and /query endpoints. ' +
        'Returns aggregated stats: total queries, split by source (MCP vs HTTP), top caller hints, ' +
        'top user-agents, top questions, top models, latency percentiles, and a time-bucketed trend. ' +
        'Useful for understanding how external AI clients are discovering and querying the candidate.',
      inputSchema: {
        since: z.string().datetime().optional().describe('ISO timestamp lower bound. Defaults to 7 days ago.'),
        until: z.string().datetime().optional().describe('ISO timestamp upper bound. Defaults to now.'),
        source: z.enum(['mcp', 'http']).optional().describe('Filter to one surface. Omit for both.'),
        caller_hint: z.string().optional().describe('Filter by caller_hint prefix (e.g. "ATS", "recruiter").'),
        bucket: z.enum(['hour', 'day', 'week']).optional().default('day').describe('Time bucket for the trend series.'),
        top_n: z.number().int().min(1).max(50).optional().default(10).describe('How many rows to include in top-N lists.'),
        format: z.enum(['text', 'json']).optional().default('text').describe('"text" returns a human summary; "json" returns the raw envelope.'),
      },
    },
    async (input) => {
      return summarizeObservedQueries(input)
    }
  )

  server.registerTool(
    'update_profile',
    {
      title: 'Update Public Profile',
      description:
        'Update one or more fields of the public-facing profile. All fields are optional — only send what should change. ' +
        'Use this after reviewing recent thoughts to keep the profile current with new skills, projects, roles, or availability. ' +
        'IMPORTANT: this profile is publicly queryable by employer AI systems — only include professional achievements, skills, projects, and availability. ' +
        'Never include private observations, personal notes, salary expectations, or anything not suitable for a resume. ' +
        'When updating the summary, first call the `search_thoughts` tool to query Open Brain for a recent "voice reference" thought ' +
        '(e.g., using a query about the candidate\'s tone or self-description) and then write the summary in the candidate\'s own voice based on that result.',
      inputSchema: {
        summary:      z.string().optional().describe('Updated professional summary'),
        tagline:      z.string().optional().describe('Short identity tagline shown under the candidate\'s name (e.g. "Full systems. Every layer. One engineer."). Overrides preferred_roles display when set.'),
        skills:       z.array(z.unknown()).optional().describe('Full updated skills array (replaces existing)'),
        employment:   z.array(z.unknown()).optional().describe('Full updated employment array (replaces existing)'),
        projects:     z.array(z.unknown()).optional().describe('Full updated projects array (replaces existing)'),
        education:    z.array(z.unknown()).optional().describe('Full updated education array (replaces existing)'),
        availability: z.record(z.unknown()).optional().describe('Updated availability object (status, roles, start_date, etc.)'),
        contact:      z.record(z.unknown()).optional().describe('Updated contact object (email, calendly, linkedin, etc.)'),
      },
    },
    async (delta) => {
      try {
        const updates = Object.fromEntries(
          Object.entries(delta).filter(([, v]) => v !== undefined)
        )

        if (Object.keys(updates).length === 0) {
          return { content: [{ type: 'text' as const, text: 'No fields provided — nothing updated.' }] }
        }

        const { data, error } = await supabase
          .from('public_profile')
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq('id', '00000000-0000-0000-0000-000000000001')
          .select('id')
          .single()

        if (error || !data) {
          const message = error?.message ?? 'Profile not found or not updated.'
          return { content: [{ type: 'text' as const, text: `Failed to update profile: ${message}` }], isError: true }
        }

        invalidateProfileCache()
        const updated = Object.keys(updates).join(', ')
        return { content: [{ type: 'text' as const, text: `Profile updated — fields changed: ${updated}` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'upsert_project',
    {
      title: 'Upsert Project',
      description:
        'Add or update a portfolio project by slug. If a project with the same slug exists it is merged (only provided fields overwrite); otherwise it is appended. ' +
        'Use this to capture new portfolio work or update an existing project without touching the rest of the profile.',
      inputSchema: {
        slug:             z.string().describe('URL-safe identifier, e.g. "artisan-roast"'),
        name:             z.string().optional().describe('Display name of the project'),
        description:      z.string().optional().describe('One-liner for list views'),
        problem:          z.string().optional().describe('What problem it solves'),
        role:             z.string().optional().describe('Your role on the project'),
        tech:             z.array(z.string()).optional().describe('Tech stack'),
        highlights:       z.array(z.string()).optional().describe('Key achievements'),
        architecture:     z.string().optional().describe('Technical architecture summary'),
        impact:           z.string().optional().describe('Measurable business/user impact'),
        status:           z.enum(['active', 'in-progress', 'archived']).optional().describe('Project status'),
        started:          z.string().optional().describe('Start month, e.g. "2024-01"'),
        url:              z.string().optional().describe('Live URL'),
        urlLabel:         z.string().optional().describe('Custom text for the live URL button, e.g. "Deploy on Railway" — consumers fall back to "Live demo" when unset'),
        repo:             z.string().optional().describe('Source repo URL'),
        docsPath:         z.string().optional().describe('Path to architecture doc if README.md is not the right source, e.g. "docs/platform/architecture.md"'),
        featureDocsGlobs: z.array(z.string()).optional().describe('Directory prefixes to scan for additional feature docs, e.g. ["docs/features"]'),
        skipChangelog:    z.union([z.boolean(), z.enum(['true', 'false']).transform(v => v === 'true')]).optional().describe('Skip changelog processing (highlights reconciliation, thought extraction, version drift detection) — use for private repos whose CHANGELOG contains business-sensitive content'),
      },
    },
    async (input) => {
      try {
        const { data, error: fetchError } = await supabase
          .from('public_profile')
          .select('projects')
          .eq('id', '00000000-0000-0000-0000-000000000001')
          .single()

        if (fetchError || !data) {
          return { content: [{ type: 'text' as const, text: 'Failed to load profile.' }], isError: true }
        }

        const projects: Project[] = data.projects ?? []
        const existingIdx = projects.findIndex((p) => p.slug === input.slug)
        const incoming = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))

        let action: string
        if (existingIdx >= 0) {
          projects[existingIdx] = { ...projects[existingIdx], ...incoming } as Project
          action = 'updated'
        } else {
          const REQUIRED_FOR_INSERT = ['name', 'description', 'problem', 'role', 'tech', 'highlights', 'status'] as const
          const missing = REQUIRED_FOR_INSERT.filter((f) => incoming[f] === undefined)
          if (missing.length > 0) {
            return { content: [{ type: 'text' as const, text: `Missing required field(s) for new project: ${missing.join(', ')}` }], isError: true }
          }
          projects.push(incoming as unknown as Project)
          action = 'added'
        }

        const { data: updated, error: updateError } = await supabase
          .from('public_profile')
          .update({ projects, updated_at: new Date().toISOString() })
          .eq('id', '00000000-0000-0000-0000-000000000001')
          .select('id')
          .single()

        if (updateError || !updated) {
          const message = updateError?.message ?? 'Profile not found while saving project.'
          return { content: [{ type: 'text' as const, text: `Failed to save project: ${message}` }], isError: true }
        }

        invalidateProfileCache()
        const label = (input.name ?? input.slug)
        return { content: [{ type: 'text' as const, text: `Project "${label}" (${input.slug}) ${action}.` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'upsert_publication',
    {
      title: 'Upsert Publication',
      description:
        'Add or update a published piece (blog post, X thread, YouTube script) by slug. If a publication with the same slug exists it is merged (only provided fields overwrite); otherwise it is appended. ' +
        'Use this to record a newly published piece or update an existing one without touching the rest of the profile.',
      inputSchema: UPSERT_PUBLICATION_INPUT_SCHEMA,
    },
    async (input) => {
      try {
        const { data, error: fetchError } = await supabase
          .from('public_profile')
          .select('publications')
          .eq('id', '00000000-0000-0000-0000-000000000001')
          .single()

        if (fetchError || !data) {
          return { content: [{ type: 'text' as const, text: 'Failed to load profile.' }], isError: true }
        }

        const publications: Publication[] = data.publications ?? []
        const result = mergePublication(publications, input)

        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: result.error }], isError: true }
        }

        const { data: updated, error: updateError } = await supabase
          .from('public_profile')
          .update({ publications: result.publications, updated_at: new Date().toISOString() })
          .eq('id', '00000000-0000-0000-0000-000000000001')
          .select('id')
          .single()

        if (updateError || !updated) {
          const message = updateError?.message ?? 'Profile not found while saving publication.'
          return { content: [{ type: 'text' as const, text: `Failed to save publication: ${message}` }], isError: true }
        }

        invalidateProfileCache()
        const label = (input.title ?? input.slug)
        return { content: [{ type: 'text' as const, text: `Publication "${label}" (${input.slug}) ${result.action}.` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'capture_thought',
    {
      title: 'Capture Thought',
      description:
        'Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain — notes, insights, decisions, or observations. Pass private:true to keep a thought out of the public /query and /public-mcp surfaces (it stays visible only here, in the private MCP).',
      inputSchema: {
        content: z.string().describe('The thought to capture — a clear, standalone statement that will make sense when retrieved later'),
        private: z.boolean().optional().describe('When true, this thought is excluded from the public /query and /public-mcp surfaces. Default false — thoughts are public-eligible.'),
      },
    },
    async ({ content, private: isPrivate }) => {
      try {
        const [embedding, metadata] = await Promise.all([getEmbedding(content), extractMetadata(content)])

        const { error } = await supabase.from('thoughts').insert({
          content,
          embedding,
          // buildThoughtMetadata strips any `source`/`private` keys the model
          // emitted and sets them solely from the explicit args — so `private` is
          // controlled by the caller, never by model drift or an injected string.
          // Only written when true; absent = public, matching match_thoughts_public's
          // `@> {private:true}` guard.
          metadata: buildThoughtMetadata(metadata, { source: 'mcp', private: isPrivate }),
        })

        if (error) return { content: [{ type: 'text' as const, text: `Failed to capture: ${error.message}` }], isError: true }

        const meta = metadata as Record<string, unknown>
        let confirmation = `Captured as ${meta.type || 'thought'}`
        if (isPrivate) confirmation += ' (private — not on the public surface)'
        if (Array.isArray(meta.topics) && meta.topics.length) confirmation += ` — ${(meta.topics as string[]).join(', ')}`
        if (Array.isArray(meta.people) && meta.people.length) confirmation += ` | People: ${(meta.people as string[]).join(', ')}`
        if (Array.isArray(meta.action_items) && meta.action_items.length) confirmation += ` | Actions: ${(meta.action_items as string[]).join('; ')}`

        return { content: [{ type: 'text' as const, text: confirmation }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'update_thought',
    {
      title: 'Update Thought',
      description:
        'Edit an existing thought by ID. When `content` is provided, regenerates the embedding and re-extracts metadata so semantic search stays consistent with the new text. ' +
        'The `private` flag and `source` are preserved from the existing record unless `private` is passed explicitly. ' +
        'Find the ID via search_thoughts or list_thoughts (both surface it in their output).',
      inputSchema: {
        id: z.string().uuid().describe('UUID of the thought to update'),
        content: z.string().optional().describe('New thought text. If provided, embedding and metadata are regenerated.'),
        private: z.boolean().optional().describe('Override the privacy flag. Omit to leave unchanged. Pass true to hide from public surfaces; false to make public-eligible.'),
      },
    },
    async ({ id, content, private: isPrivate }) => {
      try {
        if (content === undefined && isPrivate === undefined) {
          return { content: [{ type: 'text' as const, text: 'Nothing to update — provide `content` and/or `private`.' }] }
        }

        const { data: existing, error: fetchError } = await supabase
          .from('thoughts')
          .select('metadata')
          .eq('id', id)
          .single()

        if (fetchError) {
          // PGRST116 = no rows returned via .single() — genuine not-found.
          // Anything else (RLS, network, schema) should surface the real cause
          // so the caller doesn't see a misleading "not found" for a transient failure.
          if (fetchError.code === 'PGRST116') {
            return { content: [{ type: 'text' as const, text: `Thought not found: ${id}` }], isError: true }
          }
          return { content: [{ type: 'text' as const, text: `Failed to load thought ${id}: ${fetchError.message}` }], isError: true }
        }

        const opts = resolveThoughtUpdateOpts(existing.metadata, { private: isPrivate })
        const update: Record<string, unknown> = {}

        if (content !== undefined) {
          const [embedding, extracted] = await Promise.all([getEmbedding(content), extractMetadata(content)])
          update.content = content
          update.embedding = embedding
          update.metadata = buildThoughtMetadata(extracted, opts)
        } else {
          // privacy-only change: rebuild metadata from existing extracted fields,
          // stripping reserved keys via buildThoughtMetadata.
          update.metadata = buildThoughtMetadata(existing.metadata, opts)
        }

        // .select().single() forces a representation back so we can confirm a
        // row was actually touched. Without it, PostgREST can return success
        // with 0 affected rows (e.g. on a concurrent delete) and we'd happily
        // report "updated" for a row that no longer exists.
        const { data: updated, error: updateError } = await supabase
          .from('thoughts')
          .update(update)
          .eq('id', id)
          .select('id')
          .single()
        if (updateError) {
          if (updateError.code === 'PGRST116') {
            return { content: [{ type: 'text' as const, text: `Thought not found: ${id}` }], isError: true }
          }
          return { content: [{ type: 'text' as const, text: `Failed to update thought: ${updateError.message}` }], isError: true }
        }
        if (!updated) {
          return { content: [{ type: 'text' as const, text: `Thought not found: ${id}` }], isError: true }
        }

        const changed: string[] = []
        if (content !== undefined) changed.push('content', 'embedding', 'metadata')
        else if (isPrivate !== undefined) changed.push(`private=${opts.private}`)

        return { content: [{ type: 'text' as const, text: `Thought ${id} updated — ${changed.join(', ')}.` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'delete_thought',
    {
      title: 'Delete Thought',
      description:
        'Permanently delete a thought by ID. Irreversible — there is no soft-delete. ' +
        'Find the ID via search_thoughts or list_thoughts (both surface it in their output).',
      inputSchema: {
        id: z.string().uuid().describe('UUID of the thought to delete'),
      },
    },
    async ({ id }) => {
      try {
        // .select().single() on the delete returns the deleted row and lets us
        // detect "no row matched" via PGRST116, so a concurrent delete or a
        // stale ID can't produce a false "Deleted" confirmation.
        const { data: deleted, error: deleteError } = await supabase
          .from('thoughts')
          .delete()
          .eq('id', id)
          .select('content')
          .single()

        if (deleteError) {
          if (deleteError.code === 'PGRST116') {
            return { content: [{ type: 'text' as const, text: `Thought not found: ${id}` }], isError: true }
          }
          return { content: [{ type: 'text' as const, text: `Failed to delete thought: ${deleteError.message}` }], isError: true }
        }
        if (!deleted) {
          return { content: [{ type: 'text' as const, text: `Thought not found: ${id}` }], isError: true }
        }

        const preview = deleted.content.length > 80 ? deleted.content.slice(0, 77) + '...' : deleted.content
        return { content: [{ type: 'text' as const, text: `Deleted thought ${id}\n  "${preview}"` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  // ── Pipeline Tools ────────────────────────────────────────

  const STAGES = APPLICATION_STAGES
  const SUBMITTED_PIPELINE_STAGES = ['applied', 'phone_screen', 'technical', 'final', 'offer'] as const
  const TERMINAL_STAGES = ['rejected', 'withdrawn'] as const

  server.registerTool(
    'score_match',
    {
      title: 'Score Job Match',
      description:
        'Score a job description against the candidate profile and return a fit breakdown of the qualities this JD actually raises (skills, experience, domain — extracted per-JD, not a fixed checklist), each with a match verdict and evidence grade, plus a recommended action.',
      inputSchema: {
        job_description: z.string().describe('Full or partial job description text'),
      },
    },
    async ({ job_description }) => {
      let result
      try {
        result = await scoreMatch(job_description)
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Failed to score match: ${(err as Error).message}` }], isError: true }
      }
      if (!result) {
        return { content: [{ type: 'text' as const, text: 'Failed to score match — model or parse error.' }], isError: true }
      }

      const CATEGORY_LABEL = { skill: 'Skills', experience: 'Experience', domain: 'Domain' } as const
      const lines = [
        `Fit score: ${result.fit_score} → ${result.recommended_action}`,
        `Verdict: ${result.verdict}`,
        ``,
        ...(Object.keys(CATEGORY_LABEL) as Array<keyof typeof CATEGORY_LABEL>).map((category) => {
          const qualities = result.scoring.scored_qualities.filter((q) => q.category === category)
          if (qualities.length === 0) return `${CATEGORY_LABEL[category]}: (no qualities raised by this JD)`
          const detail = qualities.map((q) => `${q.name} [${q.verdict}/${q.evidence_grade}]`).join(', ')
          return `${CATEGORY_LABEL[category]}: ${detail}`
        }),
      ]

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    }
  )

  server.registerTool(
    'log_application',
    {
      title: 'Log Job Application',
      description:
        'Log a new job application. If a job description is provided, automatically scores fit against the candidate profile. Pass is_submitted: false to save a tailored draft; use confirm_application_submission with the exact resume evidence after it is actually sent.',
      inputSchema: {
        company: z.string().describe('Company name'),
        role: z.string().describe('Job title / role name'),
        job_description: z.string().optional().describe('Full JD text — used to auto-score fit'),
        source: z.string().optional().describe('Where you found it: LinkedIn, referral, cold, etc.'),
        url: z.string().optional().describe('Job posting URL'),
        applied_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Date applied if not today, e.g. 2026-03-25'),
        notes: z.string().optional().describe('Any initial notes about the role or company'),
        resume_content: z.record(z.unknown()).optional().describe('The exact structured tailored-resume object that was generated for this submission — stored verbatim as the durable evidence record'),
        docx_base64: z.string().optional().describe('The submitted .docx file, base64-encoded — stored durably with a content hash'),
        pdf_base64: z.string().optional().describe('The submitted .pdf file, base64-encoded — stored durably with a content hash'),
        is_submitted: z.boolean().optional().describe('Whether this resume version was actually sent to the employer, as opposed to tailored/staged but not yet confirmed submitted. Defaults to true — pass false for a call that logs ahead of confirmed submission (e.g. an automated tailoring pass a human hasn\'t applied with yet).'),
      },
    },
    async ({ company, role, job_description, source, url, applied_at, notes, resume_content, docx_base64, pdf_base64, is_submitted }) => {
      try {
        const hasDraftEvidence = (resume_content !== undefined && Object.keys(resume_content).length > 0) || Boolean(docx_base64 || pdf_base64)
        if (is_submitted === false && !hasDraftEvidence) {
          return {
            content: [{ type: 'text' as const, text: 'A draft application requires tailored resume_content, docx_base64, or pdf_base64 so the exact submission can be confirmed later.' }],
            isError: true,
          }
        }

        let scoreResult: Awaited<ReturnType<typeof scoreMatch>> = null
        let scoreProvenance: MatchScoreProvenance | undefined
        if (job_description) {
          const scored = await scoreMatchWithProvenance(job_description)
          scoreResult = scored?.response ?? null
          scoreProvenance = scored?.provenance
        }

        // A caller logging ahead of confirmed submission (is_submitted:
        // false) must not land in 'applied' — every stage-driven consumer
        // (the pipeline feed's by_stage totals, job-hunt-agent's
        // already-applied dedupe checks) trusts stage as ground truth for
        // "this was actually sent", and would silently treat a merely-
        // tailored entry as a real submission otherwise.
        const initialStage = (is_submitted ?? true) ? 'applied' : 'draft'
        // This token binds the score to the JD capture caused by this exact
        // writer operation. Content hashes alone are not sufficient: an
        // application can legitimately capture the same text more than once.
        const jobDescriptionCaptureOperationId = job_description ? randomUUID() : undefined

        const { data, error } = await supabase
          .from('job_applications')
          .insert({
            company, role, job_description, source, url, notes,
            job_description_capture_operation_id: jobDescriptionCaptureOperationId,
            stage: initialStage,
            applied_at: applied_at ? new Date(applied_at).toISOString() : undefined,
            ...(scoreResult && {
              fit_score: scoreResult.fit_score,
              match_verdict: scoreResult.verdict,
              match_scoring: scoreResult.scoring,
              recommended_action: scoreResult.recommended_action,
            }),
          })
          .select('id')
          .single()

        if (error || !data) {
          return { content: [{ type: 'text' as const, text: `Failed to log application: ${error?.message}` }], isError: true }
        }

        const { error: stageError } = await supabase.from('application_stages').insert({
          application_id: data.id,
          stage: initialStage,
          note: initialStage === 'draft' ? 'Application tailored, not yet confirmed submitted' : 'Application logged',
        })

        if (stageError) {
          await supabase.from('job_applications').delete().eq('id', data.id)
          return { content: [{ type: 'text' as const, text: `Failed to log stage history: ${stageError.message}` }], isError: true }
        }

        // Durable evidence bundle: the exact resume content/file that was
        // submitted. Best-effort — a failure here must not roll back the
        // application record itself, since the application was genuinely
        // logged either way. The jd_fit score below is recorded regardless
        // of whether evidence was attached — it's the append-only history
        // for every scored submission, not conditional on this bundle.
        let evidenceNote = ''
        let resumeId: string | undefined
        if (resume_content || docx_base64 || pdf_base64) {
          const uploadedPaths: string[] = []
          // Only cleared once the application_resumes row exists — cleanup
          // in the catch block below must not delete blobs a saved row is
          // already pointing at (it would orphan the row's references
          // instead of the blob), only ones left behind by a failure before
          // that row was created.
          let resumeRowCreated = false
          // Generated upfront rather than left to the row's own default, so
          // the storage path can be scoped to this specific resume version.
          // Without it, every version for the same application uploads to
          // the same `<app-id>/resume.<ext>` key and `upsert: true` quietly
          // overwrites an earlier submitted blob with a later re-tailor's
          // bytes while that earlier row's own hash still claims the old
          // content.
          const candidateResumeId = randomUUID()
          try {
            const uploads: { docx_url?: string; docx_hash?: string; pdf_url?: string; pdf_hash?: string } = {}
            for (const [ext, base64, contentType] of [
              ['docx', docx_base64, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
              ['pdf', pdf_base64, 'application/pdf'],
            ] as const) {
              if (!base64) continue
              // Buffer.from(..., 'base64') silently drops invalid characters
              // instead of throwing, so a corrupted payload would otherwise
              // be hashed/stored/reported as success with no error surfaced.
              // Whitespace is stripped first — line-wrapped base64 (the
              // `base64`/`openssl base64` CLIs wrap at 76 columns by
              // default) is otherwise valid and would fail this check.
              const cleaned = base64.replace(/\s+/g, '')
              if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
                throw new Error(`${ext}_base64 is not valid base64`)
              }
              const buf = Buffer.from(cleaned, 'base64')
              const hash = createHash('sha256').update(buf).digest('hex')
              const path = `${data.id}/${candidateResumeId}/resume.${ext}`
              const { error: uploadErr } = await supabase.storage
                .from('resume-artifacts')
                .upload(path, buf, { contentType, upsert: true })
              if (uploadErr) throw new Error(`${ext} upload failed: ${uploadErr.message}`)
              uploadedPaths.push(path)
              if (ext === 'docx') { uploads.docx_url = path; uploads.docx_hash = hash }
              else { uploads.pdf_url = path; uploads.pdf_hash = hash }
            }

            const { error: resumeErr } = await supabase
              .from('application_resumes')
              .insert({
                id: candidateResumeId,
                application_id: data.id,
                resume_content: resume_content ?? {},
                ...uploads,
                is_submitted: is_submitted ?? true,
              })
            if (resumeErr) throw new Error(`resume record failed: ${resumeErr.message}`)
            resumeRowCreated = true
            resumeId = candidateResumeId
            // Explicit positive marker, not just the absence of a failure
            // note below — a caller running against an older, undeployed
            // server that doesn't recognize resume_content/docx_base64/
            // pdf_base64 at all would also produce a response with no
            // failure marker (the fields are just silently ignored), which
            // is indistinguishable from genuine success without this.
            evidenceNote = '\n(evidence bundle saved)'
          } catch (evidenceErr: unknown) {
            // Best-effort cleanup so a partial failure before the
            // application_resumes row exists (e.g. the pdf upload succeeds,
            // then the resume-row insert itself fails) doesn't leave an
            // orphaned blob in the bucket with no row pointing at it. Once
            // that row exists (e.g. only the later score insert failed),
            // the blobs stay — deleting them would orphan the row instead.
            if (uploadedPaths.length && !resumeRowCreated) {
              const { error: removeErr } = await supabase.storage.from('resume-artifacts').remove(uploadedPaths)
              if (removeErr) console.error(`resume-artifacts cleanup failed for ${uploadedPaths.join(', ')}: ${removeErr.message}`)
            }
            if (initialStage === 'draft') {
              const { error: deleteErr } = await supabase.from('job_applications').delete().eq('id', data.id)
              if (deleteErr) console.error(`draft cleanup failed for ${data.id}: ${deleteErr.message}`)
              return {
                content: [{ type: 'text' as const, text: `Failed to save required draft evidence: ${(evidenceErr as Error).message}` }],
                isError: true,
              }
            }
            evidenceNote = `\n(evidence bundle not fully saved: ${(evidenceErr as Error).message})`
          }
        }

        if (scoreResult) {
          let jobDescriptionVersionId: string | null = null
          if (jobDescriptionCaptureOperationId) {
            const { data: descriptionVersions, error: descriptionVersionErr } = await supabase
              .from('application_job_description_versions')
              .select('id')
              .eq('application_id', data.id)
              .eq('capture_operation_id', jobDescriptionCaptureOperationId)
              .limit(2)
            if (descriptionVersionErr || !descriptionVersions || descriptionVersions.length !== 1) {
              evidenceNote += '\n(score provenance incomplete: job description version unavailable)'
            } else {
              jobDescriptionVersionId = descriptionVersions[0].id
            }
          }
          const { error: scoreErr } = await supabase.from('application_scores').insert({
            application_id: data.id,
            resume_id: resumeId ?? null,
            job_description_version_id: jobDescriptionVersionId,
            score_type: 'jd_fit',
            score: scoreResult.fit_score,
            rationale: scoreResult.verdict,
            requirement_evidence: scoreResult.scoring,
            model: scoreProvenance?.model ?? null,
            rubric_version: scoreProvenance?.rubric_version ?? null,
            rubric_hash: scoreProvenance?.rubric_hash ?? null,
            profile_hash: scoreProvenance?.profile_hash ?? null,
          })
          if (scoreErr) evidenceNote += `\n(score history not saved: ${scoreErr.message})`
        }

        const fitLine = scoreResult
          ? `Fit: ${scoreResult.fit_score} (${scoreResult.recommended_action})`
          : 'Fit: not scored (no JD provided)'

        return {
          content: [{
            type: 'text' as const,
            text: [`Application logged: ${company} — ${role}`, `Stage: ${initialStage} | ${fitLine}`, scoreResult ? `Verdict: ${scoreResult.verdict}` : '', `ID: ${data.id}${evidenceNote}`].filter(Boolean).join('\n'),
          }],
        }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'confirm_application_submission',
    {
      title: 'Confirm Application Submission',
      description: 'Atomically confirm that a draft application was sent using one exact, previously unsubmitted resume evidence record. This is the only way to move a draft to applied.',
      inputSchema: {
        application_id: z.string().uuid().describe('The draft application ID'),
        resume_id: z.string().uuid().describe('The exact unsubmitted application_resumes evidence ID that was sent'),
        note: z.string().optional().describe('Optional note about the confirmed submission'),
        actual_submission_occurred_at: z.string().datetime({ offset: true }).optional().describe('Optional time the client says the submission occurred. This is distinct from server recording time and is not independently verified.'),
        confirmation_source: z.enum(['client_attested', 'unknown']).optional().describe('Attribution for this internal confirmation. Defaults to unknown; client_attested is not independent ATS evidence.'),
        source_ref: z.string().max(512).optional().describe('Optional client-provided reference for the attestation; never interpreted as an arbitrary storage path.'),
        submitted_job_description_version_id: z.string().uuid().optional().describe('Optional JD version actually used for the sent application; must belong to this application.'),
        submitted_artifact_format: z.enum(['docx', 'pdf']).optional().describe('Optional exact artifact format the client attests was sent.'),
        submitted_artifact_hash: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Optional SHA-256 of the exact artifact the client attests was sent; validated against the selected resume.'),
      },
    },
    async ({ application_id, resume_id, note, actual_submission_occurred_at, confirmation_source, source_ref, submitted_job_description_version_id, submitted_artifact_format, submitted_artifact_hash }) => {
      try {
        const { data, error } = await supabase.rpc('confirm_application_submission', {
          p_application_id: application_id,
          p_resume_id: resume_id,
          p_note: note ?? null,
          p_actual_submission_occurred_at: actual_submission_occurred_at ?? null,
          p_confirmation_source: confirmation_source ?? 'unknown',
          p_source_ref: source_ref ?? null,
          p_submitted_job_description_version_id: submitted_job_description_version_id ?? null,
          p_submitted_artifact_format: submitted_artifact_format ?? null,
          p_submitted_artifact_hash: submitted_artifact_hash ?? null,
        })

        if (error || !data) {
          return { content: [{ type: 'text' as const, text: `Failed to confirm application submission: ${error?.message ?? 'No confirmation returned'}` }], isError: true }
        }

        const confirmed = data as {
          application_id: string
          resume_id: string
          company: string
          role: string
          previous_stage: string
          stage: string
        }
        return {
          content: [{
            type: 'text' as const,
            text: `${confirmed.company} — ${confirmed.role}: ${confirmed.previous_stage} → ${confirmed.stage}\nConfirmed resume evidence: ${confirmed.resume_id}`,
          }],
        }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'update_stage',
    {
      title: 'Update Application Stage',
      description: 'Move a job application to a new stage and record it in the history. To move a draft to applied, use confirm_application_submission with the exact submitted resume evidence.',
      inputSchema: {
        application_id: z.string().uuid().describe('The application ID'),
        stage: z.enum(STAGES).describe('New stage'),
        note: z.string().optional().describe('Optional note about this transition'),
      },
    },
    async ({ application_id, stage, note }) => {
      try {
        const { data: app, error: fetchErr } = await supabase
          .from('job_applications').select('company, role, stage').eq('id', application_id).single()

        if (fetchErr || !app) {
          return { content: [{ type: 'text' as const, text: `Application not found: ${application_id}` }], isError: true }
        }

        if (stage === 'draft') {
          return {
            content: [{
              type: 'text' as const,
              text: 'Draft is a creation-only stage. Create a new draft with log_application instead of moving an existing application back to draft.',
            }],
            isError: true,
          }
        }

        const entersSubmittedPipeline = SUBMITTED_PIPELINE_STAGES.includes(stage as typeof SUBMITTED_PIPELINE_STAGES[number])
        const isTerminal = TERMINAL_STAGES.includes(app.stage as typeof TERMINAL_STAGES[number])
        if (entersSubmittedPipeline && app.stage === 'draft') {
          return {
            content: [{
              type: 'text' as const,
              text: 'Only confirm_application_submission can enter the submitted pipeline from a draft because it requires the exact resume evidence that was sent.',
            }],
            isError: true,
          }
        }
        if (entersSubmittedPipeline && isTerminal) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Rejected or withdrawn applications cannot re-enter the submitted pipeline. Create a new application if the role is pursued again.',
            }],
            isError: true,
          }
        }

        const { error: updateErr } = await supabase.from('job_applications').update({ stage }).eq('id', application_id)
        if (updateErr) return { content: [{ type: 'text' as const, text: `Failed to update stage: ${updateErr.message}` }], isError: true }

        const { error: insertErr } = await supabase.from('application_stages').insert({ application_id, stage, note: note ?? null })
        if (insertErr) {
          await supabase.from('job_applications').update({ stage: app.stage }).eq('id', application_id)
          return { content: [{ type: 'text' as const, text: `Failed to record stage history: ${insertErr.message}; stage change rolled back.` }], isError: true }
        }

        return { content: [{ type: 'text' as const, text: `${app.company} — ${app.role}: ${app.stage} → ${stage}${note ? `\nNote: ${note}` : ''}` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'add_contact',
    {
      title: 'Add Contact',
      description: 'Add a recruiter, hiring manager, or other contact to a job application.',
      inputSchema: {
        application_id: z.string().uuid().describe('The application ID'),
        name: z.string().describe("Contact's full name"),
        title: z.string().optional().describe('Their job title'),
        linkedin: z.string().optional().describe('LinkedIn profile URL'),
        email: z.string().optional().describe('Email address'),
        notes: z.string().optional().describe('Any notes about this contact'),
      },
    },
    async ({ application_id, name, title, linkedin, email, notes }) => {
      try {
        const { data, error } = await supabase
          .from('job_contacts')
          .insert({ application_id, name, title, linkedin, email, notes })
          .select('id')
          .single()

        if (error || !data) {
          return { content: [{ type: 'text' as const, text: `Failed to add contact: ${error?.message}` }], isError: true }
        }

        return { content: [{ type: 'text' as const, text: `Contact added: ${name}${title ? ` (${title})` : ''} | ID: ${data.id}` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'list_applications',
    {
      title: 'List Applications',
      description: "List job applications with optional filters. Use for 'where am I with everything', 'show active applications', 'what needs a follow-up'.",
      inputSchema: {
        stage: z.enum(STAGES).optional().describe('Filter by stage'),
        company: z.string().optional().describe('Filter by company name (partial match)'),
        limit: z.number().int().min(1).max(100).optional().default(20),
        days: z.number().int().min(1).optional().describe('Only applications from the last N days'),
        upcoming_followups: z.boolean().optional().describe('Only applications with a follow-up date in the next 7 days'),
      },
    },
    async ({ stage, company, limit, days, upcoming_followups }) => {
      try {
        let q = supabase
          .from('job_applications')
          .select('id, company, role, stage, fit_score, recommended_action, follow_up_date, applied_at, notes')
          .order('applied_at', { ascending: false })
          .limit(limit ?? 20)

        if (stage) q = q.eq('stage', stage)
        if (company) q = q.ilike('company', `%${company}%`)
        if (days != null) {
          const since = new Date()
          since.setDate(since.getDate() - days)
          q = q.gte('applied_at', since.toISOString())
        }
        if (upcoming_followups) {
          const today = new Date().toISOString().slice(0, 10)
          const in7 = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)
          q = q.gte('follow_up_date', today).lte('follow_up_date', in7)
        }

        const { data, error } = await q
        if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }], isError: true }
        if (!data || !data.length) return { content: [{ type: 'text' as const, text: 'No applications found.' }] }

        const rows = data.map((a: { id: string; company: string; role: string; stage: string; fit_score: number | null; follow_up_date: string | null; applied_at: string; notes: string | null }) => {
          const date = new Date(a.applied_at).toLocaleDateString()
          const fit = a.fit_score != null ? ` | fit: ${a.fit_score}` : ''
          const followup = a.follow_up_date ? ` | follow-up: ${a.follow_up_date}` : ''
          return `• [${date}] ${a.company} — ${a.role} | ${a.stage}${fit}${followup}${a.notes ? `\n  ${a.notes}` : ''}\n  ID: ${a.id}`
        })

        return { content: [{ type: 'text' as const, text: `${data.length} application(s):\n\n${rows.join('\n\n')}` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'get_application',
    {
      title: 'Get Application Details',
      description: 'Get the full details of a specific job application, including contacts, stage history, job description, submitted resume content, and score history.',
      inputSchema: {
        application_id: z.string().uuid().describe('The application ID'),
      },
    },
    async ({ application_id }) => {
      try {
        const [appRes, contactsRes, stagesRes, resumesRes, scoresRes] = await Promise.all([
          supabase.from('job_applications').select('*').eq('id', application_id).single(),
          supabase.from('job_contacts').select('name, title, linkedin, email, notes, created_at').eq('application_id', application_id).order('created_at'),
          supabase.from('application_stages').select('stage, note, occurred_at').eq('application_id', application_id).order('occurred_at'),
          supabase.from('application_resumes').select('id, resume_content, docx_url, docx_hash, pdf_url, pdf_hash, is_submitted, generated_at').eq('application_id', application_id).order('generated_at'),
          supabase.from('application_scores').select('resume_id, score_type, score, rationale, requirement_evidence, model, rubric_version, scored_at').eq('application_id', application_id).order('scored_at'),
        ])

        if (appRes.error || !appRes.data) {
          return { content: [{ type: 'text' as const, text: `Application not found: ${application_id}` }], isError: true }
        }

        const a = appRes.data
        const lines: string[] = [
          `${a.company} — ${a.role}`,
          `Stage: ${a.stage} | Applied: ${new Date(a.applied_at).toLocaleDateString()}`,
        ]

        if (a.fit_score != null) {
          lines.push(`Fit score: ${a.fit_score} | Action: ${a.recommended_action}`, `Verdict: ${a.match_verdict}`)
        }
        if (a.source) lines.push(`Source: ${a.source}`)
        if (a.url) lines.push(`URL: ${a.url}`)
        if (a.follow_up_date) lines.push(`Follow-up: ${a.follow_up_date}`)
        if (a.notes) lines.push(`Notes: ${a.notes}`)
        if (a.job_description) lines.push('', `Job description:\n${a.job_description}`)

        if (contactsRes.data?.length) {
          lines.push('', 'Contacts:')
          for (const contact of contactsRes.data) {
            lines.push(`  • ${contact.name}${contact.title ? ` (${contact.title})` : ''}${contact.email ? ` — ${contact.email}` : ''}${contact.linkedin ? ` | ${contact.linkedin}` : ''}${contact.notes ? `\n    ${contact.notes}` : ''}`)
          }
        }

        if (stagesRes.data?.length) {
          lines.push('', 'Stage history:')
          for (const s of stagesRes.data) {
            lines.push(`  ${new Date(s.occurred_at).toLocaleDateString()} → ${s.stage}${s.note ? `: ${s.note}` : ''}`)
          }
        }

        if (resumesRes.error) lines.push('', `Resume versions: unavailable (${resumesRes.error.message})`)
        else if (resumesRes.data?.length) {
          lines.push('', 'Resume versions:')
          for (const r of resumesRes.data) {
            const hashes = [r.docx_hash && `docx sha256: ${r.docx_hash}`, r.pdf_hash && `pdf sha256: ${r.pdf_hash}`].filter(Boolean).join(', ')
            lines.push(`  ${r.is_submitted ? '[submitted]' : '[generated]'} ${new Date(r.generated_at).toLocaleDateString()} | ID: ${r.id}${hashes ? ` | ${hashes}` : ''}`)
          }
          const submitted = resumesRes.data.find((r) => r.is_submitted)
          if (submitted) lines.push('', `Submitted resume content (JSON):\n${JSON.stringify(submitted.resume_content, null, 2)}`)
        }

        if (scoresRes.error) lines.push('', `Score history: unavailable (${scoresRes.error.message})`)
        else if (scoresRes.data?.length) {
          lines.push('', 'Score history:')
          for (const s of scoresRes.data) {
            const evidence = s.requirement_evidence ? ` | evidence: ${JSON.stringify(s.requirement_evidence)}` : ''
            lines.push(`  ${new Date(s.scored_at).toLocaleDateString()} [${s.score_type}] ${s.score ?? '—'}${s.model ? ` (${s.model})` : ''}${s.rationale ? `: ${s.rationale}` : ''}${evidence}`)
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'set_follow_up',
    {
      title: 'Set Follow-up Date',
      description: "Set or update a follow-up date on a job application. Use when the user says 'follow up Thursday' or 'remind me next week'.",
      inputSchema: {
        application_id: z.string().uuid().describe('The application ID'),
        follow_up_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date in YYYY-MM-DD format'),
        notes: z.string().optional().describe('What to follow up on'),
      },
    },
    async ({ application_id, follow_up_date, notes }) => {
      try {
        const { data: app, error: fetchErr } = await supabase
          .from('job_applications').select('company, role').eq('id', application_id).single()

        if (fetchErr || !app) {
          return { content: [{ type: 'text' as const, text: `Application not found: ${application_id}` }], isError: true }
        }

        const update: Record<string, unknown> = { follow_up_date }
        if (notes) update.notes = notes

        const { error } = await supabase.from('job_applications').update(update).eq('id', application_id)
        if (error) return { content: [{ type: 'text' as const, text: `Failed to set follow-up: ${error.message}` }], isError: true }

        return { content: [{ type: 'text' as const, text: `Follow-up set: ${app.company} — ${app.role} on ${follow_up_date}${notes ? `\nNote: ${notes}` : ''}` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'search_applications',
    {
      title: 'Search Applications',
      description: 'Search job applications by free text across company name, role, job description, and notes.',
      inputSchema: {
        query: z.string().describe('Search term — matches against company, role, job description, and notes'),
        limit: z.number().int().min(1).max(50).optional().default(10),
      },
    },
    async ({ query, limit }) => {
      try {
        const sanitizedQuery = query.replace(/[%'"(),]/g, ' ').trim()
        const { data, error } = await supabase
          .from('job_applications')
          .select('id, company, role, stage, fit_score, applied_at, job_description')
          .or(`company.ilike.%${sanitizedQuery}%,role.ilike.%${sanitizedQuery}%,job_description.ilike.%${sanitizedQuery}%,notes.ilike.%${sanitizedQuery}%`)
          .order('applied_at', { ascending: false })
          .limit(limit ?? 10)

        if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }], isError: true }
        if (!data || !data.length) return { content: [{ type: 'text' as const, text: `No applications found matching "${query}".` }] }

        const rows = data.map((a: { id: string; company: string; role: string; stage: string; fit_score: number | null; applied_at: string; job_description: string | null }) =>
          `• ${a.company} — ${a.role} | ${a.stage}${a.fit_score != null ? ` | fit: ${a.fit_score}` : ''} | ${new Date(a.applied_at).toLocaleDateString()}\n  ID: ${a.id}${a.job_description ? `\n  JD: ${a.job_description.slice(0, 200)}${a.job_description.length > 200 ? '…' : ''}` : ''}`
        )

        return { content: [{ type: 'text' as const, text: `${data.length} result(s) for "${query}":\n\n${rows.join('\n\n')}` }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  return server
}

// ── Hono App ──────────────────────────────────────────────
// CORS helpers (ALLOWED_ORIGINS, corsHeaders, checkOrigin) live in src/lib/mcp-common.ts
// so the public-mcp route can reuse them without duplication.

async function authenticate(c: Context): Promise<boolean> {
  const brainKey = c.req.header('x-brain-key')
  if (brainKey && timingSafeEqual(brainKey, OPEN_BRAIN_KEY!)) return true

  const authHeader = c.req.header('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (bearerToken && jwtSecretBytes) {
    try {
      const result = await jwtVerify(bearerToken, jwtSecretBytes, { algorithms: ['HS256'] })
      if (process.env.DEBUG === 'true') {
        console.log('[mcp] authenticate success', { sub: result.payload.sub, exp: result.payload.exp })
      }
      return true
    } catch (err) {
      console.log('[mcp] authenticate failure', { error: (err as Error).message })
    }
  }
  return false
}

function unauthorized(c: Context): Response {
  const baseUrl = process.env.PUBLIC_URL
    ? new URL(process.env.PUBLIC_URL)
    : new URL(c.req.url)
  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource', baseUrl).toString()
  return c.json({ error: 'Invalid or missing credentials' }, 401, {
    ...corsHeaders,
    'WWW-Authenticate': `Bearer realm="${baseUrl.origin}", resource_metadata="${resourceMetadataUrl}"`,
  }) as Response
}

// ── Routes ────────────────────────────────────────────────
// Stateless transport: each POST creates a fresh McpServer + transport, handles
// the request, and discards both. No session state is kept in process memory.
// GET and DELETE are not registered — clients receive 404 for those methods.

const mcpRoute = new Hono()

// CORS preflight — no auth required
mcpRoute.options('*', (c) => {
  const originErr = checkOrigin(c)
  if (originErr) return originErr
  return c.text('ok', 200, corsHeaders)
})

// POST — stateless: fresh server + transport per request
mcpRoute.post('*', async (c) => {
  const originErr = checkOrigin(c)
  if (originErr) return originErr

  if (!await authenticate(c)) return unauthorized(c)

  const server = buildServer()
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)

  const response = await transport.handleRequest(c)
  if (!response) return c.json({ error: 'No response from MCP transport' }, 500, corsHeaders)

  // Strip any session ID the transport may emit — this server is stateless;
  // issuing a session ID would mislead clients into expecting session resumption.
  response.headers.delete('mcp-session-id')

  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value)
  }
  return response
})

export default mcpRoute
