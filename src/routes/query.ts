import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { supabase } from '../lib/supabase.js'
import { getModel, MODEL } from '../lib/ai.js'
import { generateText, streamText, tool } from 'ai'
import { parseJSON } from '../lib/parse-json.js'
import { detectCaller, callerContextFromQuery } from '../lib/detect-caller.js'
import { logObservedQuery } from '../lib/log-observed-query.js'
import { queryRelevantThoughtsForQuestion } from '../lib/thoughts-query.js'
import { buildSystemPrompt, parseShownProjectSlugs, sanitizeCallerHint, sortProjectsByRecency } from '../lib/query-prompt.js'
import { isBinaryQuestion, isBehavioralQuestion, maxTokensForQuestion } from '../lib/query-classify.js'
import type { QueryResponse } from '../types.js'

const app = new Hono()

// ── Profile cache ────────────────────────────────────────
// Profile changes at most a few times per day (via MCP or sync).
// A 5-min TTL eliminates one Supabase round-trip per request.
// Intentional tradeoff: callers may see data up to 5 minutes stale after
// a profile update. Acceptable given how infrequently the profile changes.

interface ProfileCache { data: unknown; expiresAt: number }
let profileCache: ProfileCache | null = null
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000

async function fetchProfile() {
  const now = Date.now()
  if (profileCache && now < profileCache.expiresAt) {
    return { data: profileCache.data, error: null }
  }
  const result = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()
  if (!result.error && result.data) {
    profileCache = { data: result.data, expiresAt: now + PROFILE_CACHE_TTL_MS }
  }
  return result
}

// ── Thoughts version cache ───────────────────────────────
// A lightweight version token for OB1 public thoughts: MAX(updated_at) across
// all thoughts rows. Changes whenever any thought is added or updated, which
// is the signal needed to invalidate observation-grounded cached responses.
// TTL: 60s — fast enough to pick up new captures within a minute.
// Note: thoughts.updated_at is not indexed by default; this query does an
// ORDER BY … LIMIT 1 which may scan/sort as the table grows. Add an
// updated_at DESC index if thoughts volume becomes large.

interface ThoughtsVersionCache { version: string; expiresAt: number }
let thoughtsVersionCache: ThoughtsVersionCache | null = null
const THOUGHTS_VERSION_TTL_MS = 60 * 1000

async function fetchThoughtsVersion(): Promise<string> {
  const now = Date.now()
  if (thoughtsVersionCache && now < thoughtsVersionCache.expiresAt) {
    return thoughtsVersionCache.version
  }
  const { data, error } = await supabase
    .from('thoughts')
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    // On failure: return a volatile value so no cached response is served
    // (volatile key = cache miss on every request until the query recovers).
    // Don't persist to thoughtsVersionCache — keep retrying each request.
    return `error:${now}`
  }
  const version = (data as { updated_at?: string } | null)?.updated_at ?? ''
  thoughtsVersionCache = { version, expiresAt: now + THOUGHTS_VERSION_TTL_MS }
  return version
}

// ── Response cache ───────────────────────────────────────
// Key: JSON-encoded tuple of [normalized(question), style, callerHint[:80], profile.updated_at, thoughts_version, prompt_version]
// (JSON-encoded, not delimiter-joined — several fields can legally contain
// a plain separator character like ":", which would risk key collisions)
// Dimensions:
//   - style       — cited vs conversational changes the system prompt format
//   - callerHint  — affects tone; truncated to 80 chars to bound key size while
//                   still separating major caller types (ATS, human, interviewer)
//   - profile.updated_at — changes on every profile mutation
//   - thoughts_version   — changes on every OB1 thought add/update (60s TTL)
//   - prompt_version      — hash of the actual prompt/tool-calling source (below).
//     Nothing else in this key changes when a RULE_* constant or a tool
//     `description` changes, which let a pre-fix cached response for the exact
//     "Show recent work" starter-chip question keep serving the broken
//     open_match_tool routing from #180 well after #181/#182 shipped — the
//     process never restarted the way a deploy was assumed to guarantee.
//     Hashing the prompt source makes this dimension self-maintaining: any
//     future prompt-logic edit automatically orphans the old cache entries,
//     with no manual version bump and no dependence on process-restart timing.
// Staleness bound: max(profile cache TTL 5min, thoughts version TTL 60s) = 5min,
// PLUS instant invalidation on any prompt-logic change via prompt_version.
// Eviction: LRU (Map insertion order; get refreshes recency). Cap: 200 entries.
// Streaming path is not cached (returns a live streamText handle).

/** Pure hash over prompt-logic source strings — exported so tests can verify the mechanism without depending on real prompt content. */
export function computePromptVersion(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12)
}

const RESPONSE_CACHE_MAX = 200
const responseCache = new Map<string, import('../types.js').QueryResponse>()

export function responseCacheKey(
  question: string,
  style: string,
  callerHint: string,
  profileUpdatedAt: string,
  thoughtsVersion: string,
  promptVersion: string,
): string {
  const q = question.toLowerCase().trim().replace(/\s+/g, ' ')
  const hint = callerHint.toLowerCase().trim().slice(0, 80)
  // JSON-encode the tuple rather than joining with a delimiter (e.g. ":") —
  // several fields can legally contain that delimiter themselves
  // (callerHint, ISO timestamps in profileUpdatedAt, thoughtsVersion's
  // `error:${now}` fallback), which risks two different tuples colliding on
  // the same key string.
  return JSON.stringify([q, style, hint, profileUpdatedAt, thoughtsVersion, promptVersion])
}

// Exported alongside responseCacheKey/computePromptVersion so the "never
// serve/store an action_intent-bearing response" contract (#188) is directly
// unit-testable — seed the cache via responseCacheSet, then assert
// responseCacheGet treats it as a miss, without needing a live model call.
export function responseCacheGet(
  question: string,
  style: string,
  callerHint: string,
  profileUpdatedAt: string,
  thoughtsVersion: string,
): import('../types.js').QueryResponse | undefined {
  const key = responseCacheKey(question, style, callerHint, profileUpdatedAt, thoughtsVersion, PROMPT_VERSION)
  const value = responseCache.get(key)
  if (value === undefined) return undefined
  // Guard the read side too, not just responseCacheSet: an action_intent-bearing
  // entry can already be sitting in the Map from before this guard existed (this
  // is exactly what happened in production — see the "never cache" comment
  // below). Treat it as a miss and evict it, rather than trusting that nothing
  // was ever written that shouldn't have been.
  if (value.action_intent) {
    responseCache.delete(key)
    return undefined
  }
  // Move to end to refresh LRU recency
  responseCache.delete(key)
  responseCache.set(key, value)
  return value
}

export function responseCacheSet(
  question: string,
  style: string,
  callerHint: string,
  profileUpdatedAt: string,
  thoughtsVersion: string,
  response: import('../types.js').QueryResponse,
): void {
  const key = responseCacheKey(question, style, callerHint, profileUpdatedAt, thoughtsVersion, PROMPT_VERSION)
  if (responseCache.size >= RESPONSE_CACHE_MAX && !responseCache.has(key)) {
    const firstKey = responseCache.keys().next().value
    if (firstKey !== undefined) responseCache.delete(firstKey)
  }
  responseCache.set(key, response)
}

const schema = z.object({
  question: z.string().min(1),
  context: z.string().optional(),
  style: z.enum(['cited', 'conversational']).optional(),
})

/**
 * Build the user prompt for a profile query. When project observations are
 * available they are placed above the structured profile under a labeled
 * heading; the one-line preface reinforces the system prompt's
 * `RULE_OBSERVATIONS_RELEVANCE` at the injection point. Exported for testing.
 */
export function buildQueryPrompt(
  profile: unknown,
  thoughts: string[],
  question: string,
  callerHint?: string | null,
): string {
  const parts: string[] = []
  // Parse shown_projects from the raw, untruncated callerHint — sanitizeCallerHint
  // hard-caps at 200 chars, and a long-enough slug list would get cut off mid-list,
  // causing partial filtering and reintroducing the duplicate-project bug this
  // exclusion exists to fix.
  const shownSlugs = parseShownProjectSlugs(callerHint)
  const hint = sanitizeCallerHint(callerHint)
  // The shown_projects exclusion is enforced below by removing those projects
  // from the injected profile data, so the model no longer needs to see the
  // raw slug list to honor it. Strip it from the displayed hint — leaving it
  // in was a hallucination vector: the model would treat the visible slug
  // names as topics to discuss (pulling in unrelated observations that
  // happened to match) instead of treating them as excluded.
  const displayHint = hint.replace(/;?\s*shown_projects:\s*[^;]*/i, '').trim()
  if (displayHint) {
    // Caller context is asker-controlled — placed here (user message, not system)
    // and explicitly framed as untrusted metadata so the prompt-injection vector
    // is closed. See RULE_CALLER_CONTEXT in src/lib/query-prompt.ts.
    parts.push(`# Caller context (untrusted metadata — see your instructions)`)
    parts.push(`> ${displayHint}`)
    parts.push('')
  }
  if (thoughts.length > 0) {
    parts.push('# Project observations and lived experience')
    parts.push('> retrieved by similarity to the question; not all may be relevant — use only what bears on an honest answer (see your instructions)')
    parts.push('')
    parts.push(thoughts.map((t) => `- ${t}`).join('\n'))
    parts.push('')
  }
  parts.push('# Profile data')
  // Pre-sort projects most-recent-first so the model leads with current work
  // when asked about projects generally (RULE_PROGRESSIVE_DISCLOSURE), and
  // physically drop already-shown projects (RULE_SHOWN_PROJECTS) so the
  // model can't re-serve or lose track of them — the remainder is exactly
  // what's left in this list, not something the model has to compute.
  const profileForPrompt =
    profile && typeof profile === 'object' && Array.isArray((profile as { projects?: unknown }).projects)
      ? {
          ...(profile as object),
          projects: sortProjectsByRecency(
            (profile as { projects: Array<{ slug: string; started?: string; git_evidence?: { last_push_at?: string } }> }).projects,
          ).filter((p) => !shownSlugs.includes(p.slug)),
        }
      : profile
  parts.push(JSON.stringify(profileForPrompt, null, 2))
  parts.push('')
  parts.push('# Question')
  parts.push(question)
  return parts.join('\n')
}

// ── Action-intent tool (#174) ────────────────────────────────
//
// Hoisted to module scope — never construct a Zod schema inside a handler.
// `execute` is intentionally omitted: nothing runs server-side when the
// model calls this. The call itself IS the signal — queryProfile reads
// `result.toolCalls` and turns it into `response.action_intent`, a
// first-class field the frontend consumes directly instead of re-deriving
// intent from free text (see RULE_ACTION_INTENT for the exact boundary).

const OPEN_MATCH_TOOL_DESCRIPTION =
  'Call ONLY when EITHER (1) the message pairs a role reference (however brief — see below, no formal job ' +
  'description required) with a request to check fit against it or tailor the résumé to it, OR (2) the message ' +
  'directly asks to see/open the résumé document itself (no role or JD required for this branch — naming the ' +
  'résumé document is enough on its own). Branch (1) ' +
  'has TWO independent requirements — BOTH must hold, checked separately: (i) an explicit fit-check/tailor/match ' +
  'request — "would this be a good fit", "check if Sunny fits/matches", "tailor the résumé to this role/this" — ' +
  'without this, branch (1) fails regardless of how much role detail is present; and (ii) at least one role-' +
  'identifying signal anywhere in the message (a job title, a team/org unit, a company descriptor — named OR ' +
  'anonymized like "a Series B startup" — a technical skill/requirement, or a scope/responsibility phrase). ' +
  'Requirement (ii) is loose — ONE signal, in plain prose, no pasted job-posting block, no named company ' +
  'needed — but it never substitutes for requirement (i). "What projects has Sunny built?" has role-adjacent ' +
  'words ("built") but ZERO fit/match/tailor request — that fails (i) and must NOT call the tool, regardless of ' +
  '(ii). Only ask for more detail (rather than call the tool) when (i) is present but (ii) is entirely absent ' +
  '(e.g. "would this role be a good match?" alone, no title/team/company/skill/scope anywhere). If neither ' +
  'branch applies, do NOT call this — regardless of surface words like "work", "built", "worked on", "shipped", ' +
  'or "portfolio". Any request to see or discuss the candidate\'s past projects/portfolio/work in general, with ' +
  'no job description or role attached and no mention of the résumé document, is answered narratively via ' +
  'project_slugs, not this tool. See your instructions for the full narrated-vs-action-request boundary.'

const QUERY_TOOLS = {
  open_match_tool: tool({
    description: OPEN_MATCH_TOOL_DESCRIPTION,
    parameters: z.object({}),
  }),
}

// Response-cache versioning dimension (see the "Response cache" section
// above) — computed once at module load from the actual prompt/tool-calling
// source, not maintained by hand. Any edit to a RULE_* constant or this
// tool's description automatically changes this value.
const PROMPT_VERSION = computePromptVersion(
  buildSystemPrompt('json', 'cited'),
  buildSystemPrompt('json', 'conversational'),
  OPEN_MATCH_TOOL_DESCRIPTION,
)

/**
 * Pure derivation of `QueryResponse.action_intent` from a `generateText` result's
 * `toolCalls`. Extracted from `queryProfile` so the routing signal is unit-testable
 * without a live model call — exported for that purpose.
 */
export function deriveActionIntent(toolCalls: readonly { toolName: string }[]): { tool: string } | null {
  const match = toolCalls.find((c) => c.toolName === 'open_match_tool')
  return match ? { tool: match.toolName } : null
}

/**
 * Pull OpenRouter's `provider` field out of a `generateText` result's raw
 * `response` (an OpenRouter-specific extension of the OpenAI-compatible
 * response body, not part of the AI SDK's own typed shape — hence the
 * defensive unknown-narrowing rather than a direct property access). Pure
 * and exported for unit testing without a live model call; see #189.
 */
export function extractProvider(modelResponse: unknown): string | undefined {
  const body = (modelResponse as { body?: unknown } | undefined)?.body
  const provider = (body as { provider?: unknown } | undefined)?.provider
  return typeof provider === 'string' ? provider : undefined
}

/**
 * Whether a computed `/query` response is safe to cache. `open_match_tool`'s
 * routing decision is a model judgment call, not perfectly deterministic
 * (#188/#189) — caching a response that carries an `action_intent` risks
 * freezing a single bad (or good) roll and serving it to every subsequent
 * visitor asking the same question, until something else invalidates the
 * entry. Extracted to a named predicate so the "never cache this class of
 * response" contract is unit-testable in isolation.
 */
export function shouldCacheResponse(response: Pick<QueryResponse, 'action_intent'>): boolean {
  return !response.action_intent
}

// ── Shared core ─────────────────────────────────────────────
//
// queryProfile / queryProfileStream are pure functions — no Hono Context,
// no framework deps. Called by both the HTTP /query handler below and the
// ask_candidate MCP tool in public-mcp.ts.

export interface QueryProfileArgs {
  question: string
  callerHint: string
  style?: 'cited' | 'conversational'
}

export interface ProfileNotFoundError {
  kind: 'profile_not_found'
}

export interface ParseError {
  kind: 'parse_error'
  raw: string
}

/** Non-streaming query — returns a structured QueryResponse or a typed error. */
export async function queryProfile(
  args: QueryProfileArgs,
): Promise<QueryResponse | ProfileNotFoundError | ParseError> {
  // Fetch profile + OB1 version token in parallel — both are in-process cached
  // and usually synchronous; parallel fetch keeps cold-start cost minimal.
  const [{ data: profile, error }, thoughtsVersion] = await Promise.all([
    fetchProfile(),
    fetchThoughtsVersion(),
  ])
  if (error || !profile) return { kind: 'profile_not_found' }

  const profileUpdatedAt = (profile as { updated_at?: string }).updated_at ?? ''

  const style = args.style ?? 'cited'

  // Response cache check — all question types. Key covers both data dimensions
  // plus style and callerHint to prevent cross-caller response bleed.
  // On hit: skip retrieval + LLM entirely; stamp fresh meta.
  const cached = responseCacheGet(args.question, style, args.callerHint, profileUpdatedAt, thoughtsVersion)
  if (cached) return { ...cached, meta: { ...cached.meta, latency_ms: 0, retrieval_ms: 0 } }

  // Retrieval — only on cache miss, skipped entirely for binary questions.
  const skipThoughts = isBinaryQuestion(args.question)
  const retrievalStart = Date.now()
  const thoughts = skipThoughts ? [] : await queryRelevantThoughtsForQuestion(args.question)
  const retrieval_ms = Date.now() - retrievalStart

  const prompt = buildQueryPrompt(profile, thoughts, args.question, args.callerHint)

  const start = Date.now()
  const { text: raw, toolCalls, finishReason, response: modelResponse } = await generateText({
    model: getModel(),
    maxTokens: maxTokensForQuestion(args.question, args.style ?? 'cited'),
    system: buildSystemPrompt('json', style),
    prompt,
    tools: QUERY_TOOLS,
  })
  const latency_ms = Date.now() - start
  const actionIntent = deriveActionIntent(toolCalls)
  const provider = extractProvider(modelResponse)

  let parsed: Pick<QueryResponse, 'answer' | 'confidence' | 'sources' | 'follow_up_suggestions'> & { project_slugs?: string[] }
  try {
    parsed = parseJSON(raw)
  } catch (err) {
    if (actionIntent) {
      // The model called the tool but didn't also produce the JSON envelope
      // RULE_ACTION_INTENT asks for alongside it. The tool call is
      // unambiguous signal on its own — degrade to a minimal response
      // rather than a parse_error. A non-empty answer matters here: until
      // resume-agent-web switches to reading action_intent, this text is
      // what a legacy client actually displays — an empty string would
      // surface as a blank response body despite the request succeeding.
      parsed = { answer: 'Opening the job-fit tool now.', confidence: 'low', sources: [], follow_up_suggestions: [] }
    } else {
      console.error('[query] parse_error:', err, '— raw (first 500 chars):', raw.slice(0, 500))
      return { kind: 'parse_error', raw }
    }
  }

  const response: QueryResponse = {
    ...parsed,
    project_slugs: parsed.project_slugs ?? [],
    action_intent: actionIntent,
    contact: {
      email: profile.contact?.email,
      calendly: profile.contact?.calendly,
    },
    meta: { model: MODEL, latency_ms, retrieval_ms, provider, finish_reason: finishReason },
  }

  // Cache — key covers all prompt dimensions (question, style, callerHint,
  // profile version, OB1 version, prompt version). EXCEPT: never cache a
  // response that carries an action_intent. open_match_tool's routing
  // decision is a model judgment call, not perfectly deterministic — a
  // single unlucky (or lucky) roll caching itself here would freeze that
  // one outcome and serve it to every subsequent visitor asking the same
  // question, until something else invalidates the entry. Recomputing
  // every time trades a latency win for correctness on exactly the
  // decision where a stuck wrong answer does the most damage (redirecting,
  // or failing to redirect, every visitor to the job-fit flow).
  if (shouldCacheResponse(response)) {
    responseCacheSet(args.question, style, args.callerHint, profileUpdatedAt, thoughtsVersion, response)
  }

  return response
}

/** Streaming variant — returns the streamText result for caller-controlled consumption. */
export async function queryProfileStream(
  args: QueryProfileArgs,
): Promise<ReturnType<typeof streamText> | ProfileNotFoundError> {
  const skipThoughts = isBinaryQuestion(args.question)
  const [{ data: profile, error }, thoughts] = await Promise.all([
    fetchProfile(),
    skipThoughts ? Promise.resolve([]) : queryRelevantThoughtsForQuestion(args.question),
  ])

  if (error || !profile) {
    return { kind: 'profile_not_found' }
  }

  const prompt = buildQueryPrompt(profile, thoughts, args.question, args.callerHint)

  return streamText({
    model: getModel(),
    maxTokens: maxTokensForQuestion(args.question, args.style ?? 'cited'),
    system: buildSystemPrompt('stream', args.style ?? 'cited'),
    prompt,
  })
}

// ── HTTP wrapper ────────────────────────────────────────────

function deriveCallerHint(c: Context, question: string, context: string | undefined): string {
  const headerCaller = detectCaller(c)
  const queryCaller = callerContextFromQuery(question)
  const caller = headerCaller.type !== 'unknown'
    ? headerCaller
    : { ...headerCaller, ...queryCaller }
  return (context?.trim() || undefined) ?? caller.hint
}

function deriveStyle(
  explicitStyle: 'cited' | 'conversational' | undefined,
): 'cited' | 'conversational' {
  if (explicitStyle) return explicitStyle
  // 'conversational' style used to default here for 'human' callers (a
  // shorter, citation-marker-free prose format for the chat UI). Removed:
  // that specific combination (conversational style + the real 'human'
  // caller-hint) was the one reliably reproducible open_match_tool
  // misfire found in #191's investigation — 'cited' style has never shown
  // this failure anywhere it's used (public-mcp, ATS, recruiter,
  // hiring-manager, personal-ai). resume-agent-web's sanitizeAnswer()
  // already strips [N] markers and the Sources: block unconditionally
  // (lib/answer.ts), so switching the default doesn't change what a
  // visitor actually sees — only the model's internal reliability.
  return 'cited'
}

async function handleQuery(
  c: Context,
  question: string,
  context: string | undefined,
  stream: boolean,
  style?: 'cited' | 'conversational',
): Promise<Response> {
  const callerHint = deriveCallerHint(c, question, context)
  const effectiveStyle = deriveStyle(style)
  const requestIp = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  const userAgent = c.req.header('user-agent')
  const overallStart = Date.now()

  if (stream) {
    // Conversational mode relies on the JSON sources[] array; stream returns plain text with no
    // JSON envelope, so conversational attribution cannot be emitted. Fall back to cited.
    const result = await queryProfileStream({ question, callerHint, style: 'cited' })
    if ('kind' in result && result.kind === 'profile_not_found') {
      return c.json({ error: 'Profile not found' }, 404)
    }

    // Tee the stream: forward bytes to the client, collect text for post-hoc logging.
    const live = result as ReturnType<typeof streamText>
    const response = live.toTextStreamResponse()
    const original = response.body
    if (!original) return response

    const [toClient, forLogging] = original.tee()

    // Collect the logging branch in the background (fire-and-forget)
    ;(async () => {
      const reader = forLogging.getReader()
      const decoder = new TextDecoder()
      let collected = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        collected += decoder.decode(value, { stream: true })
      }
      collected += decoder.decode()
      await logObservedQuery({
        source: 'http',
        question,
        caller_hint: callerHint,
        response: { answer: collected },
        latency_ms: Date.now() - overallStart,
        ip: requestIp,
        user_agent: userAgent,
      })
    })().catch((err) => {
      console.warn('[query] background streaming log failed:', (err as Error).message)
    })

    return new Response(toClient, response)
  }

  const result = await queryProfile({ question, callerHint, style: effectiveStyle })

  if ('kind' in result) {
    if (result.kind === 'profile_not_found') return c.json({ error: 'Profile not found' }, 404)
    return c.json({ error: 'Failed to parse agent response' }, 500)
  }

  // Fire-and-forget logging (never throws)
  void logObservedQuery({
    source: 'http',
    question,
    caller_hint: callerHint,
    response: result,
    latency_ms: Date.now() - overallStart,
    ip: requestIp,
    user_agent: userAgent,
  })

  c.header('Cache-Control', 'no-store')
  return c.json(result)
}

// ── Routes ──────────────────────────────────────────────────

app.get('/', async (c) => {
  const rawQuestion = c.req.query('question')
  if (rawQuestion !== undefined) {
    const parsedInput = schema.safeParse({ question: rawQuestion, context: c.req.query('context') })
    if (!parsedInput.success) {
      return c.json({ error: 'Invalid query', details: parsedInput.error.format() }, 400)
    }
    const stream = c.req.query('stream') === 'true'
    return handleQuery(c, parsedInput.data.question, parsedInput.data.context, stream)
  }
  const url = new URL(c.req.url)
  return c.json({
    endpoint: url.pathname,
    method: 'POST',
    also_supports: 'GET ?question=',
    description: 'Ask a natural language question about this candidate.',
    body: {
      question: 'string (required)',
      context: 'string (optional, e.g. "ATS", "recruiter", "ai-agent")',
      stream: 'boolean (optional, default false)',
    },
    response: {
      when_stream_false: 'application/json — { answer, confidence, sources, follow_up_suggestions, contact, meta }',
      when_stream_true: 'text/plain — streamed plain text chunks; response body is not JSON in this mode',
    },
    get_usage: 'GET /query?question=Your+question+here&stream=true',
    example: { question: 'What is your experience with TypeScript?', stream: false },
    example_streaming: { question: 'What is your experience with TypeScript?', stream: true },
  })
})

app.post('/', zValidator('json', schema.extend({ stream: z.boolean().optional() })), async (c) => {
  const { question, context, stream, style } = c.req.valid('json')
  return handleQuery(c, question, context, stream ?? false, style)
})

export default app
