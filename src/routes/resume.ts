import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { getModel } from '../lib/ai.js'
import { generateText } from 'ai'
import { parseJSON } from '../lib/parse-json.js'
import type { ResumeResponse } from '../types.js'

const app = new Hono()

const schema = z.object({
  job_description: z.string().min(1),
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
  const { job_description } = c.req.valid('json')

  const { data: profile, error } = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error || !profile) {
    return c.json({ error: 'Profile not found' }, 404)
  }

  const systemPrompt = `You are a professional resume writer. Generate a tailored resume for the candidate based on their profile and the target job description.

Rules:
- Lead with matched qualifications
- Reframe experience using the role's language where truthful
- Omit irrelevant history
- Never fabricate credentials, titles, dates, or skills
- Keep to 2 pages worth of content

Respond with structured JSON:
{
  "contact": { ... },
  "summary": "...",
  "skills": [...],
  "employment": [...],
  "education": [...],
  "projects": [...]
}`

  const userMessage = `Candidate profile:
${JSON.stringify(profile, null, 2)}

Target job description:
${job_description}`

  const { text: raw } = await generateText({
    model: getModel(),
    maxTokens: 2048,
    system: systemPrompt,
    prompt: userMessage,
  })

  let parsed: ResumeResponse
  try {
    parsed = parseJSON(raw) as ResumeResponse
  } catch {
    return c.json({ error: 'Failed to parse resume response' }, 500)
  }

  return c.json(parsed)
})

export default app
