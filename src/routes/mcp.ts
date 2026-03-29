import '../lib/env.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { jwtVerify } from 'jose'
import { supabase } from '../lib/supabase.js'

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY
const JWT_SECRET = process.env.JWT_SECRET
const jwtSecretBytes = JWT_SECRET ? new TextEncoder().encode(JWT_SECRET) : null

if (!OPENROUTER_API_KEY) throw new Error('Missing OPENROUTER_API_KEY')
if (!MCP_ACCESS_KEY) throw new Error('Missing MCP_ACCESS_KEY')

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

// ── Helpers ───────────────────────────────────────────────

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: text }),
  })
  if (!r.ok) {
    const msg = await r.text().catch(() => '')
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`)
  }
  const d = await r.json()
  return d.data[0].embedding
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: 'user', content: text },
      ],
    }),
  })
  if (!r.ok) {
    console.error(`OpenRouter metadata extraction failed: ${r.status}`)
    return { topics: ['uncategorized'], type: 'observation' }
  }
  const d = await r.json()
  try {
    return JSON.parse(d.choices[0].message.content)
  } catch {
    return { topics: ['uncategorized'], type: 'observation' }
  }
}

interface MatchScoreResult {
  fit_score: number
  match_verdict: string
  match_scoring: Record<string, unknown>
  recommended_action: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

async function scoreMatch(jobDescription: string): Promise<MatchScoreResult | null> {
  try {
    const { data: profile, error } = await supabase
      .from('public_profile')
      .select('*')
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .single()

    if (error || !profile) return null

    const systemPrompt = `You are a precise job fit evaluator. Extract requirements from the job description and score the candidate profile against them using only the discrete values defined below.

--- SCORING RUBRIC ---

SKILLS
For each skill explicitly marked as REQUIRED in the JD (ignore preferred/nice-to-have):
- matched (1.0): directly present in candidate profile
- partial (0.5): adjacent technology (e.g. Vue when React required, MySQL when Postgres required)
- missing (0.0): absent from profile

EXPERIENCE — score each sub-factor independently:
- years:    meets or exceeds required (1.0) | 1-2 years short (0.7) | 3-4 years short (0.4) | significantly under (0.1)
- scope:    IC/lead/manager alignment — exact match (1.0) | similar (0.7) | different (0.3)
- recency:  relevant exp is current/last role (1.0) | within 3 yrs (0.7) | 3-5 yrs ago (0.4) | 5+ yrs ago (0.1)

DOMAIN — score each sub-factor independently:
- industry:      same industry (1.0) | adjacent (0.6) | different (0.3)
- product_type:  same product category (1.0) | similar (0.7) | different (0.3)
- scale:         company/product scale matches (1.0) | similar (0.7) | different (0.4)

--- OUTPUT ---

Respond ONLY with valid JSON. No prose, no markdown fences.

{
  "required_skills_extracted": ["skill1", "skill2"],
  "skills": {
    "matched": ["skill1"],
    "partial": ["skill2"],
    "missing": ["skill3"]
  },
  "experience": { "years": 0.7, "scope": 1.0, "recency": 1.0 },
  "domain": { "industry": 0.6, "product_type": 1.0, "scale": 0.7 },
  "verdict": "one sentence explaining the overall fit honestly"
}`

    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Candidate profile:\n${JSON.stringify(profile, null, 2)}\n\nJob description:\n${jobDescription}`,
          },
        ],
      }),
    })

    if (!r.ok) return null

    const d = await r.json()
    const raw = d.choices[0].message.content as string
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const scores = JSON.parse(json)

    const total_required = (scores.required_skills_extracted as string[]).length || 1
    const skills_score =
      (scores.skills.matched.length * 1.0 + scores.skills.partial.length * 0.5) / total_required

    const { years, scope, recency } = scores.experience
    const exp_score = (years + scope + recency) / 3

    const { industry, product_type, scale } = scores.domain
    const domain_score = (industry + product_type + scale) / 3

    const fit_score = round2(0.5 * skills_score + 0.3 * exp_score + 0.2 * domain_score)
    const recommended_action =
      fit_score >= 0.8 ? 'apply' : fit_score >= 0.6 ? 'apply-with-tailoring' : 'pass'

    return {
      fit_score,
      match_verdict: scores.verdict,
      match_scoring: {
        skills: {
          matched: scores.skills.matched,
          partial: scores.skills.partial,
          missing: scores.skills.missing,
          score: round2(skills_score),
        },
        experience: { years, scope, recency, score: round2(exp_score) },
        domain: { industry, product_type, scale, score: round2(domain_score) },
      },
      recommended_action,
    }
  } catch {
    return null
  }
}

// ── MCP Server ────────────────────────────────────────────

function buildServer(): McpServer {
  const server = new McpServer({ name: 'open-brain', version: '1.0.0' })

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
        const { data, error } = await supabase.rpc('match_thoughts', {
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
          (t: { content: string; metadata: Record<string, unknown>; similarity: number; created_at: string }, i: number) => {
            const m = t.metadata || {}
            const parts = [
              `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
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
          .select('content, metadata, created_at')
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

        const results = data.map((t: { content: string; metadata: Record<string, unknown>; created_at: string }, i: number) => {
          const m = t.metadata || {}
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(', ') : ''
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || '??'}${tags ? ' - ' + tags : ''})\n   ${t.content}`
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
    'update_profile',
    {
      title: 'Update Public Profile',
      description:
        'Update one or more fields of the public-facing profile. All fields are optional — only send what should change. Use this after reviewing recent thoughts to keep the profile current with new skills, projects, roles, or availability. IMPORTANT: this profile is publicly queryable by employer AI systems — only include professional achievements, skills, projects, and availability. Never include private observations, personal notes, salary expectations, or anything not suitable for a resume. When updating the summary, search Open Brain for a voice reference thought first and write in the candidate\'s own voice.',
      inputSchema: {
        summary:      z.string().optional().describe('Updated professional summary'),
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

        const updated = Object.keys(updates).join(', ')
        return { content: [{ type: 'text' as const, text: `Profile updated — fields changed: ${updated}` }] }
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
        'Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain — notes, insights, decisions, or observations.',
      inputSchema: {
        content: z.string().describe('The thought to capture — a clear, standalone statement that will make sense when retrieved later'),
      },
    },
    async ({ content }) => {
      try {
        const [embedding, metadata] = await Promise.all([getEmbedding(content), extractMetadata(content)])

        const { error } = await supabase.from('thoughts').insert({
          content,
          embedding,
          metadata: { ...metadata, source: 'mcp' },
        })

        if (error) return { content: [{ type: 'text' as const, text: `Failed to capture: ${error.message}` }], isError: true }

        const meta = metadata as Record<string, unknown>
        let confirmation = `Captured as ${meta.type || 'thought'}`
        if (Array.isArray(meta.topics) && meta.topics.length) confirmation += ` — ${(meta.topics as string[]).join(', ')}`
        if (Array.isArray(meta.people) && meta.people.length) confirmation += ` | People: ${(meta.people as string[]).join(', ')}`
        if (Array.isArray(meta.action_items) && meta.action_items.length) confirmation += ` | Actions: ${(meta.action_items as string[]).join('; ')}`

        return { content: [{ type: 'text' as const, text: confirmation }] }
      } catch (err: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true }
      }
    }
  )

  // ── Pipeline Tools ────────────────────────────────────────

  const STAGES = ['applied', 'phone_screen', 'technical', 'final', 'offer', 'rejected', 'withdrawn'] as const

  server.registerTool(
    'log_application',
    {
      title: 'Log Job Application',
      description:
        'Log a new job application. If a job description is provided, automatically scores fit against the candidate profile.',
      inputSchema: {
        company: z.string().describe('Company name'),
        role: z.string().describe('Job title / role name'),
        job_description: z.string().optional().describe('Full JD text — used to auto-score fit'),
        source: z.string().optional().describe('Where you found it: LinkedIn, referral, cold, etc.'),
        url: z.string().optional().describe('Job posting URL'),
        applied_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Date applied if not today, e.g. 2026-03-25'),
        notes: z.string().optional().describe('Any initial notes about the role or company'),
      },
    },
    async ({ company, role, job_description, source, url, applied_at, notes }) => {
      try {
        let scoreResult: MatchScoreResult | null = null
        if (job_description) scoreResult = await scoreMatch(job_description)

        const { data, error } = await supabase
          .from('job_applications')
          .insert({
            company, role, job_description, source, url, notes,
            applied_at: applied_at ? new Date(applied_at).toISOString() : undefined,
            ...(scoreResult && {
              fit_score: scoreResult.fit_score,
              match_verdict: scoreResult.match_verdict,
              match_scoring: scoreResult.match_scoring,
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
          stage: 'applied',
          note: 'Application logged',
        })

        if (stageError) {
          await supabase.from('job_applications').delete().eq('id', data.id)
          return { content: [{ type: 'text' as const, text: `Failed to log stage history: ${stageError.message}` }], isError: true }
        }

        const fitLine = scoreResult
          ? `Fit: ${scoreResult.fit_score} (${scoreResult.recommended_action})`
          : 'Fit: not scored (no JD provided)'

        return {
          content: [{
            type: 'text' as const,
            text: [`Application logged: ${company} — ${role}`, `Stage: applied | ${fitLine}`, scoreResult ? `Verdict: ${scoreResult.match_verdict}` : '', `ID: ${data.id}`].filter(Boolean).join('\n'),
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
      description: 'Move a job application to a new stage and record it in the history.',
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
      description: 'Get the full details of a specific job application including contacts and stage history.',
      inputSchema: {
        application_id: z.string().uuid().describe('The application ID'),
      },
    },
    async ({ application_id }) => {
      try {
        const [appRes, contactsRes, stagesRes] = await Promise.all([
          supabase.from('job_applications').select('*').eq('id', application_id).single(),
          supabase.from('job_contacts').select('name, title, linkedin, email, notes, created_at').eq('application_id', application_id).order('created_at'),
          supabase.from('application_stages').select('stage, note, occurred_at').eq('application_id', application_id).order('occurred_at'),
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
          .select('id, company, role, stage, fit_score, applied_at')
          .or(`company.ilike.%${sanitizedQuery}%,role.ilike.%${sanitizedQuery}%,job_description.ilike.%${sanitizedQuery}%,notes.ilike.%${sanitizedQuery}%`)
          .order('applied_at', { ascending: false })
          .limit(limit ?? 10)

        if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }], isError: true }
        if (!data || !data.length) return { content: [{ type: 'text' as const, text: `No applications found matching "${query}".` }] }

        const rows = data.map((a: { id: string; company: string; role: string; stage: string; fit_score: number | null; applied_at: string }) =>
          `• ${a.company} — ${a.role} | ${a.stage}${a.fit_score != null ? ` | fit: ${a.fit_score}` : ''} | ${new Date(a.applied_at).toLocaleDateString()}\n  ID: ${a.id}`
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

// Allowed browser origins — prevents DNS rebinding attacks (MCP Streamable HTTP spec MUST)
// Non-browser clients (curl, Claude Desktop) send no Origin header and are always allowed.
const ALLOWED_ORIGINS = new Set([
  'https://claude.ai',
  ...(process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
])

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-brain-key, accept, mcp-session-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, DELETE',
} as const

function checkOrigin(c: Context): Response | null {
  const origin = c.req.header('origin')
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
  return null
}

async function authenticate(c: Context): Promise<boolean> {
  const brainKey = c.req.header('x-brain-key')
  if (brainKey && brainKey === MCP_ACCESS_KEY) return true

  const authHeader = c.req.header('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (bearerToken && jwtSecretBytes) {
    try {
      await jwtVerify(bearerToken, jwtSecretBytes, { algorithms: ['HS256'] })
      return true
    } catch {
      // fall through
    }
  }
  return false
}

const mcpRoute = new Hono()

// CORS preflight
mcpRoute.options('*', (c) => {
  const originErr = checkOrigin(c)
  if (originErr) return originErr
  return c.text('ok', 200, corsHeaders)
})

// GET — this server uses JSON response mode (no SSE); return 405 per MCP spec
mcpRoute.get('*', (c) => {
  const originErr = checkOrigin(c)
  if (originErr) return originErr
  return c.json(
    { error: 'Method not allowed — server operates in JSON response mode, not SSE' },
    405,
    { ...corsHeaders, Allow: 'POST, OPTIONS, DELETE' }
  )
})

// DELETE — stateless server, no sessions to track; acknowledge and return 200
mcpRoute.delete('*', (c) => {
  const originErr = checkOrigin(c)
  if (originErr) return originErr
  return c.body(null, 200, corsHeaders)
})

// POST — main MCP handler
mcpRoute.post('*', async (c) => {
  const originErr = checkOrigin(c)
  if (originErr) return originErr

  if (!await authenticate(c)) {
    const baseUrl = process.env.PUBLIC_URL
      ? new URL(process.env.PUBLIC_URL)
      : new URL(c.req.url)
    const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource', baseUrl).toString()
    return c.json({ error: 'Invalid or missing credentials' }, 401, {
      ...corsHeaders,
      'WWW-Authenticate': `Bearer realm="${baseUrl.origin}", resource_metadata="${resourceMetadataUrl}"`,
    })
  }

  const server = buildServer()
  const transport = new StreamableHTTPTransport({ enableJsonResponse: true })
  await server.connect(transport)

  const response = await transport.handleRequest(c)
  if (!response) return c.json({ error: 'No response from MCP transport' }, 500, corsHeaders)
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value)
  }
  return response
})

export default mcpRoute
