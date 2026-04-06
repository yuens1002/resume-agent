import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { getModel } from '../lib/ai.js'
import { generateText } from 'ai'
import { parseJSON } from '../lib/parse-json.js'
import type { ResumeResponse } from '../types.js'

const RESUME_MODEL = process.env.RESUME_MODEL ?? 'openai/gpt-4o-mini'

const app = new Hono()

const schema = z.object({
  job_description: z.string().min(1),
  framing_hints: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
})

// Private endpoint — requires Authorization: Bearer header
app.use('/', async (c, next) => {
  const authMode = process.env.AUTH_MODE ?? 'open'
  if (authMode === 'key') {
    const header = c.req.header('Authorization')
    const token = header?.replace('Bearer ', '')
    if (token !== process.env.API_KEY) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }
  await next()
})

app.post('/', zValidator('json', schema), async (c) => {
  const { job_description, framing_hints } = c.req.valid('json')

  const { data: profile, error } = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error || !profile) {
    return c.json({ error: 'Profile not found' }, 404)
  }

  const contactBlock = JSON.stringify(profile.contact)

  const systemPrompt = `You are a professional resume writer. Generate a tailored resume for the candidate based on their profile and the target job description.

Rules:
- Lead with matched qualifications
- Reframe experience using the role's language where truthful
- Omit irrelevant history
- Never fabricate credentials, titles, dates, or skills
- Keep to 2 pages worth of content
- IMPORTANT: Return the contact block EXACTLY as provided below — do not omit or reorder fields

Respond with structured JSON:
{
  "contact": ${contactBlock},
  "summary": "...",
  "skills": [...],
  "employment": [...],
  "education": [...],
  "projects": [...]
}`

  let userMessage = `Candidate profile:
${JSON.stringify(profile, null, 2)}

Target job description:
${job_description}`

  if (framing_hints?.length) {
    userMessage += `\n\nFraming guidance:\n${framing_hints.map((h) => `- ${h.replace(/\n+/g, ' ')}`).join('\n')}`
  }

  const { text: raw } = await generateText({
    model: getModel(RESUME_MODEL),
    maxTokens: 4096,
    system: systemPrompt,
    prompt: userMessage,
  })

  let parsed: ResumeResponse
  try {
    parsed = parseJSON<ResumeResponse>(raw)
  } catch {
    return c.json({ error: 'Failed to parse resume response' }, 500)
  }

  return c.json(parsed)
})

export default app
