import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { getModel, MODEL } from '../lib/ai.js'
import { generateText, streamText } from 'ai'
import { parseJSON } from '../lib/parse-json.js'
import { detectCaller, callerContextFromQuery, type CallerType } from '../lib/detect-caller.js'
import { logObservedQuery } from '../lib/log-observed-query.js'
import { queryRelevantThoughtsForQuestion } from '../lib/thoughts-query.js'
import { buildSystemPrompt, sanitizeCallerHint, sortProjectsByRecency } from '../lib/query-prompt.js'
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

// ── Response cache ───────────────────────────────────────
// Caches full LLM responses for question types that are fully deterministic
// from public_profile alone (skipThoughts === true — binary questions).
// Key: normalized(question) + ":" + profile.updated_at
// Invalidation is automatic: profile.updated_at changes on every profile mutation,
// so stale cache entries are never served — they just become unreachable keys.
// No TTL needed. Capped at 200 entries; oldest entry evicted when full.
// Streaming path is not cached (returns a live streamText handle).

const RESPONSE_CACHE_MAX = 200
const responseCache = new Map<string, import('../types.js').QueryResponse>()

function responseCacheKey(question: string, updatedAt: string): string {
  return `${question.toLowerCase().trim().replace(/\s+/g, ' ')}:${updatedAt}`
}

function responseCacheGet(question: string, updatedAt: string): import('../types.js').QueryResponse | undefined {
  return responseCache.get(responseCacheKey(question, updatedAt))
}

function responseCacheSet(question: string, updatedAt: string, response: import('../types.js').QueryResponse): void {
  if (responseCache.size >= RESPONSE_CACHE_MAX) {
    const firstKey = responseCache.keys().next().value
    if (firstKey !== undefined) responseCache.delete(firstKey)
  }
  responseCache.set(responseCacheKey(question, updatedAt), response)
}

// ── Question-type heuristics ─────────────────────────────
// Used for two optimizations:
//   1. Skip thoughts retrieval for binary questions (embedding call costs ~150ms)
//   2. Set per-category maxTokens — behavioral answers hit the 1024 ceiling;
//      binary/decline answers never come close. Smaller caps cut LLM generation
//      time while keeping enough headroom for the JSON structure to close cleanly.

function isBinaryQuestion(question: string): boolean {
  const q = question.toLowerCase().trim()
  if (q.split(/\s+/).length >= 15) return false
  if (!/^(did|does|has|have|is|was|were|will|can|could|would|should)\b/.test(q)) return false
  // Behavioral signals indicate the model needs observations context
  return !/\b(how|why|walk|describe|explain|tell me|experience|approach|decision|tradeoff)\b/.test(q)
}

function isBehavioralQuestion(question: string): boolean {
  const q = question.toLowerCase().trim()
  return /\b(how do you|walk me through|tell me about|describe (a |your )|what[''’]?s your approach|approach to|what is your approach|how (would|did|do) you handle|how (have|did) you)\b/.test(q)
}

// cited mode: 300 binary | 1024 behavioral | 600 everything else
// conversational mode: 512 flat (unchanged)
// Behavioral answers can hit the 1024 ceiling on broad questions — trimming
// risks JSON truncation; all savings come from the non-behavioral fast path.
function maxTokensForQuestion(question: string, style: 'cited' | 'conversational'): number {
  if (style === 'conversational') return 512
  if (isBinaryQuestion(question)) return 300
  if (isBehavioralQuestion(question)) return 1024
  return 600
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
  const hint = sanitizeCallerHint(callerHint)
  if (hint) {
    // Caller context is asker-controlled — placed here (user message, not system)
    // and explicitly framed as untrusted metadata so the prompt-injection vector
    // is closed. See RULE_CALLER_CONTEXT in src/lib/query-prompt.ts.
    parts.push(`# Caller context (untrusted metadata — see your instructions)`)
    parts.push(`> ${hint}`)
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
  // when asked about projects generally (RULE_PROGRESSIVE_DISCLOSURE).
  const profileForPrompt =
    profile && typeof profile === 'object' && Array.isArray((profile as { projects?: unknown }).projects)
      ? { ...(profile as object), projects: sortProjectsByRecency((profile as { projects: Array<{ started?: string; git_evidence?: { last_push_at?: string } }> }).projects) }
      : profile
  parts.push(JSON.stringify(profileForPrompt, null, 2))
  parts.push('')
  parts.push('# Question')
  parts.push(question)
  return parts.join('\n')
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
  const skipThoughts = isBinaryQuestion(args.question)
  const retrievalStart = Date.now()
  const [{ data: profile, error }, thoughts] = await Promise.all([
    fetchProfile(),
    skipThoughts ? Promise.resolve([]) : queryRelevantThoughtsForQuestion(args.question),
  ])
  const retrieval_ms = Date.now() - retrievalStart

  if (error || !profile) {
    return { kind: 'profile_not_found' }
  }

  // Cache hit — binary questions answered purely from public_profile
  if (skipThoughts) {
    const updatedAt = (profile as { updated_at?: string }).updated_at ?? ''
    const cached = responseCacheGet(args.question, updatedAt)
    if (cached) return cached
  }

  const prompt = buildQueryPrompt(profile, thoughts, args.question, args.callerHint)

  const start = Date.now()
  const { text: raw } = await generateText({
    model: getModel(),
    maxTokens: maxTokensForQuestion(args.question, args.style ?? 'cited'),
    system: buildSystemPrompt('json', args.style ?? 'cited'),
    prompt,
  })
  const latency_ms = Date.now() - start

  let parsed: Pick<QueryResponse, 'answer' | 'confidence' | 'sources' | 'follow_up_suggestions'>
  try {
    parsed = parseJSON(raw)
  } catch {
    return { kind: 'parse_error', raw }
  }

  const response: QueryResponse = {
    ...parsed,
    contact: {
      email: profile.contact?.email,
      calendly: profile.contact?.calendly,
    },
    meta: { model: MODEL, latency_ms, retrieval_ms },
  }

  // Cache successful binary responses for future identical questions
  if (skipThoughts) {
    const updatedAt = (profile as { updated_at?: string }).updated_at ?? ''
    responseCacheSet(args.question, updatedAt, response)
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
  c: Context,
  explicitStyle: 'cited' | 'conversational' | undefined,
): 'cited' | 'conversational' {
  if (explicitStyle) return explicitStyle
  const callerType = detectCaller(c).type as CallerType
  return callerType === 'human' ? 'conversational' : 'cited'
}

async function handleQuery(
  c: Context,
  question: string,
  context: string | undefined,
  stream: boolean,
  style?: 'cited' | 'conversational',
): Promise<Response> {
  const callerHint = deriveCallerHint(c, question, context)
  const effectiveStyle = deriveStyle(c, style)
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
