import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'

const app = new Hono()

// A2A-compliant agent card for autodiscovery by employer AI systems
app.get('/', async (c) => {
  const { data } = await supabase
    .from('public_profile')
    .select('contact, availability')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  const baseUrl = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`

  return c.json({
    schema_version: '1.1',
    name: data?.contact?.name ?? 'Resume Agent',
    description: 'AI agent representing a professional profile. Query skills, experience, and availability.',
    url: baseUrl,
    capabilities: ['query', 'match', 'info', 'availability', 'projects'],
    endpoints: {
      info: {
        url: `${baseUrl}/info`,
        method: 'GET',
        description: 'Returns full profile data including skills, employment, education, and projects.',
      },
      availability: {
        url: `${baseUrl}/availability`,
        method: 'GET',
        description: 'Returns current availability status and preferred roles.',
      },
      query: {
        url: `${baseUrl}/query`,
        method: 'POST',
        content_type: 'application/json',
        description: 'Ask a natural language question about this candidate.',
        input_schema: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string', description: 'Natural language question about the candidate.' },
            context: { type: 'string', description: 'Caller type hint — e.g. "ATS", "recruiter", "ai-agent".', required: false },
          },
        },
        example: { question: 'What is your experience with TypeScript?' },
      },
      match: {
        url: `${baseUrl}/match`,
        method: 'POST',
        content_type: 'application/json',
        description: 'Score this candidate against a job description and return a fit breakdown. This endpoint is POST-only; GET is not supported.',
        input_schema: {
          type: 'object',
          required: ['job_description'],
          properties: {
            job_description: { type: 'string', description: 'Full or partial job description text.' },
          },
        },
        example: { job_description: 'Senior frontend engineer, React, TypeScript, 5+ years.' },
      },
      projects: {
        url: `${baseUrl}/projects`,
        method: 'GET',
        description: 'Returns all portfolio projects with tech stack, highlights, and architecture.',
      },
    },
    contact: {
      email: data?.contact?.email,
      calendly: data?.contact?.calendly,
    },
  })
})

export default app
