import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { getModel } from '../lib/ai.js'
import { generateText } from 'ai'
import { parseJSON } from '../lib/parse-json.js'
import { detectCaller } from '../lib/detect-caller.js'
import type { MatchResponse } from '../types.js'

const app = new Hono()

const schema = z.object({
  job_description: z.string().min(1),
})

app.post('/', zValidator('json', schema), async (c) => {
  const { job_description } = c.req.valid('json')

  const caller = detectCaller(c)

  const { data: profile, error } = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error || !profile) {
    return c.json({ error: 'Profile not found' }, 404)
  }

  const systemPrompt = `You are an honest job fit evaluator. Given a candidate profile and a job description, assess fit without inflating scores or omitting real gaps.

Caller context: ${caller.hint}
Tailor your response accordingly — adjust verbosity and framing to suit the caller type.

Scoring weights:
- Required skills coverage: 50%
- Experience alignment (years, scope, recency): 30%
- Domain overlap (industry, product type, scale): 20%

Verdicts:
- >= 0.80: strong match
- 0.60–0.79: partial match
- < 0.60: weak match

Gap types: learnable (tooling/framework), structural (years/role type), fundamental (domain/function).

Respond in this exact JSON format:
{
  "fit_score": 0.00,
  "matched": ["skill1", "skill2"],
  "gaps": ["gap1", "gap2"],
  "verdict": "...",
  "recommended_action": "apply" | "apply-with-tailoring" | "pass"
}`

  const userMessage = `Candidate profile:
${JSON.stringify(profile, null, 2)}

Job description:
${job_description}`

  const { text: raw } = await generateText({
    model: getModel(),
    maxTokens: 1024,
    system: systemPrompt,
    prompt: userMessage,
  })

  let parsed: MatchResponse
  try {
    parsed = parseJSON<MatchResponse>(raw)
  } catch {
    return c.json({ error: 'Failed to parse match response' }, 500)
  }

  return c.json(parsed)
})

export default app
