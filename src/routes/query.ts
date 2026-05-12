import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { getModel, MODEL } from '../lib/ai.js'
import { generateText, streamText } from 'ai'
import { parseJSON } from '../lib/parse-json.js'
import { detectCaller, callerContextFromQuery } from '../lib/detect-caller.js'
import { logObservedQuery } from '../lib/log-observed-query.js'
import { queryRelevantThoughtsForQuestion } from '../lib/thoughts-query.js'
import type { QueryResponse } from '../types.js'

const app = new Hono()

const schema = z.object({
  question: z.string().min(1),
  context: z.string().optional(),
})

const OBSERVATIONS_GUIDANCE = `When "Project observations and lived experience" is provided below, prefer it for behavioral, decision-making, or judgment questions — those notes are the candidate's own lived experience and are higher-signal than inference over resume bullets.`

const SYSTEM_PROMPT_JSON = (callerHint: string): string => `You are an AI agent representing a professional candidate. Answer questions about their profile accurately and honestly using the structured data provided. Never fabricate credentials or inflate qualifications.

${OBSERVATIONS_GUIDANCE}

Caller context: ${callerHint}
Tailor your response accordingly — adjust tone, verbosity, and framing to suit the caller type.

Always respond in this exact JSON format:
{
  "answer": "...",
  "confidence": "high" | "medium" | "low",
  "sources": ["experience.company_name", "skills.languages", "observations"],
  "follow_up_suggestions": ["...", "..."]
}

Confidence levels:
- high: directly supported by profile data or project observations
- medium: inferred from adjacent data
- low: not well-supported, answering with caveats`

const SYSTEM_PROMPT_STREAM = (callerHint: string): string => `You are an AI agent representing a professional candidate. Answer questions about their profile accurately and honestly. Never fabricate credentials or inflate qualifications.

${OBSERVATIONS_GUIDANCE}

Caller context: ${callerHint}
Tailor your response accordingly — adjust tone, verbosity, and framing to suit the caller type.
Respond in clear, direct prose.`

/**
 * Build the user prompt for a profile query. When project observations are
 * available they are placed above the structured profile under a labeled
 * heading so the model treats them as primary context for judgment questions.
 * Exported for testing the prompt shape.
 */
export function buildQueryPrompt(profile: unknown, thoughts: string[], question: string): string {
  const parts: string[] = []
  if (thoughts.length > 0) {
    parts.push('# Project observations and lived experience')
    parts.push(thoughts.map((t) => `- ${t}`).join('\n'))
    parts.push('')
  }
  parts.push('# Profile data')
  parts.push(JSON.stringify(profile, null, 2))
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
  const [{ data: profile, error }, thoughts] = await Promise.all([
    supabase
      .from('public_profile')
      .select('*')
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .single(),
    queryRelevantThoughtsForQuestion(args.question),
  ])

  if (error || !profile) {
    return { kind: 'profile_not_found' }
  }

  const prompt = buildQueryPrompt(profile, thoughts, args.question)

  const start = Date.now()
  const { text: raw } = await generateText({
    model: getModel(),
    maxTokens: 1024,
    system: SYSTEM_PROMPT_JSON(args.callerHint),
    prompt,
  })
  const latency_ms = Date.now() - start

  let parsed: Pick<QueryResponse, 'answer' | 'confidence' | 'sources' | 'follow_up_suggestions'>
  try {
    parsed = parseJSON(raw)
  } catch {
    return { kind: 'parse_error', raw }
  }

  return {
    ...parsed,
    contact: {
      email: profile.contact?.email,
      calendly: profile.contact?.calendly,
    },
    meta: { model: MODEL, latency_ms },
  }
}

/** Streaming variant — returns the streamText result for caller-controlled consumption. */
export async function queryProfileStream(
  args: QueryProfileArgs,
): Promise<ReturnType<typeof streamText> | ProfileNotFoundError> {
  const [{ data: profile, error }, thoughts] = await Promise.all([
    supabase
      .from('public_profile')
      .select('*')
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .single(),
    queryRelevantThoughtsForQuestion(args.question),
  ])

  if (error || !profile) {
    return { kind: 'profile_not_found' }
  }

  const prompt = buildQueryPrompt(profile, thoughts, args.question)

  return streamText({
    model: getModel(),
    maxTokens: 1024,
    system: SYSTEM_PROMPT_STREAM(args.callerHint),
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

async function handleQuery(
  c: Context,
  question: string,
  context: string | undefined,
  stream: boolean,
): Promise<Response> {
  const callerHint = deriveCallerHint(c, question, context)
  const requestIp = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  const userAgent = c.req.header('user-agent')
  const overallStart = Date.now()

  if (stream) {
    const result = await queryProfileStream({ question, callerHint })
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

  const result = await queryProfile({ question, callerHint })

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
  const { question, context, stream } = c.req.valid('json')
  return handleQuery(c, question, context, stream ?? false)
})

export default app
