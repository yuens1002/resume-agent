import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { getModel, MODEL } from '../lib/ai.js'
import { generateText, streamText } from 'ai'
import { parseJSON } from '../lib/parse-json.js'
import { detectCaller, callerContextFromQuery } from '../lib/detect-caller.js'
import type { QueryResponse } from '../types.js'

const app = new Hono()

const schema = z.object({
  question: z.string().min(1),
  context: z.string().optional(),
})

async function handleQuery(c: Context, question: string, context?: string, stream = false): Promise<Response> {
  const headerCaller = detectCaller(c)
  const queryCaller = callerContextFromQuery(question)
  const caller = headerCaller.type !== 'unknown'
    ? headerCaller
    : { ...headerCaller, ...queryCaller }

  const callerHint = (context?.trim() || undefined) ?? caller.hint

  const { data: profile, error } = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error || !profile) {
    return c.json({ error: 'Profile not found' }, 404)
  }

  const prompt = `Profile data:
${JSON.stringify(profile, null, 2)}

Question: ${question}`

  if (stream) {
    const result = streamText({
      model: getModel(),
      maxTokens: 1024,
      system: `You are an AI agent representing a professional candidate. Answer questions about their profile accurately and honestly. Never fabricate credentials or inflate qualifications.

Caller context: ${callerHint}
Tailor your response accordingly — adjust tone, verbosity, and framing to suit the caller type.
Respond in clear, direct prose.`,
      prompt,
    })
    return result.toTextStreamResponse()
  }

  const start = Date.now()

  const systemPrompt = `You are an AI agent representing a professional candidate. Answer questions about their profile accurately and honestly using the structured data provided. Never fabricate credentials or inflate qualifications.

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

  const { text: raw } = await generateText({
    model: getModel(),
    maxTokens: 1024,
    system: systemPrompt,
    prompt,
  })

  const latency_ms = Date.now() - start

  let parsed: { answer: string; confidence: 'high' | 'medium' | 'low'; sources: string[]; follow_up_suggestions: string[] }
  try {
    parsed = parseJSON(raw)
  } catch {
    return c.json({ error: 'Failed to parse agent response' }, 500)
  }

  const response: QueryResponse = {
    ...parsed,
    contact: {
      email: profile.contact?.email,
      calendly: profile.contact?.calendly,
    },
    meta: { model: MODEL, latency_ms },
  }

  c.header('Cache-Control', 'no-store')
  return c.json(response)
}

app.get('/', async (c) => {
  const rawQuestion = c.req.query('question')
  if (rawQuestion !== undefined) {
    const result = schema.safeParse({ question: rawQuestion, context: c.req.query('context') })
    if (!result.success) {
      return c.json({ error: 'Invalid query', details: result.error.format() }, 400)
    }
    const stream = c.req.query('stream') === 'true'
    return handleQuery(c, result.data.question, result.data.context, stream)
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
