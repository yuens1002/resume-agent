import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { getModel, MODEL } from '../lib/ai.js'
import { generateText, streamText } from 'ai'
import { parseJSON } from '../lib/parse-json.js'
import { detectCaller, callerContextFromQuery } from '../lib/detect-caller.js'
import { logObservedQuery } from '../lib/log-observed-query.js'
import type { QueryResponse } from '../types.js'

const app = new Hono()

const schema = z.object({
  question: z.string().min(1),
  context: z.string().optional(),
})

const SYSTEM_PROMPT_JSON = (callerHint: string): string => `You are an AI agent representing a professional candidate. Answer questions about their profile accurately and honestly using the structured data provided. Never fabricate credentials or inflate qualifications.

Caller context: ${callerHint}
Tailor your response accordingly — adjust tone, verbosity, and framing to suit the caller type.

Always respond in this exact JSON format:
{
  "answer": "...",
  "confidence": "high" | "medium" | "low",
  "sources": ["experience.company_name", "skills.languages"],
  "follow_up_suggestions": ["...", "..."]
}

Confidence levels:
- high: directly supported by profile data
- medium: inferred from adjacent data
- low: not well-supported, answering with caveats`

const SYSTEM_PROMPT_STREAM = (callerHint: string): string => `You are an AI agent representing a professional candidate. Answer questions about their profile accurately and honestly. Never fabricate credentials or inflate qualifications.

Caller context: ${callerHint}
Tailor your response accordingly — adjust tone, verbosity, and framing to suit the caller type.
Respond in clear, direct prose.`

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
  const { data: profile, error } = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error || !profile) {
    return { kind: 'profile_not_found' }
  }

  const prompt = `Profile data:\n${JSON.stringify(profile, null, 2)}\n\nQuestion: ${args.question}`

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
  const { data: profile, error } = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error || !profile) {
    return { kind: 'profile_not_found' }
  }

  const prompt = `Profile data:\n${JSON.stringify(profile, null, 2)}\n\nQuestion: ${args.question}`

  return streamText({
    model: getModel(),
    maxTokens: 1024,
    system: SYSTEM_PROMPT_STREAM(args.callerHint),
    prompt,
  })
}

// ── HTTP wrapper ────────────────────────────────────────────

function deriveCallerHint(c: Context, context: string | undefined): string {
  const headerCaller = detectCaller(c)
  const queryCaller = callerContextFromQuery('')
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
  const callerHint = deriveCallerHint(c, context)
  const requestIp = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  const userAgent = c.req.header('user-agent')
  const overallStart = Date.now()

  if (stream) {
    // Streaming path does not log to observed_queries — no structured envelope
    // is available mid-stream. See log-observed-query.ts contract.
    const result = await queryProfileStream({ question, callerHint })
    if ('kind' in result && result.kind === 'profile_not_found') {
      return c.json({ error: 'Profile not found' }, 404)
    }
    return (result as ReturnType<typeof streamText>).toTextStreamResponse()
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
    caller_hint: context?.trim() || undefined,
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
