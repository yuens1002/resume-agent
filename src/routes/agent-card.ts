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
    auth: { type: 'none' },
    capabilities: ['query', 'match', 'info', 'availability', 'projects'],
    rate_limits: { requests_per_minute: 30, scope: 'per_ip' },
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
        also_supports: `GET ${baseUrl}/query?question=Your+question+here`,
        content_type: 'application/json',
        description: 'Ask a natural language question about this candidate. Supports POST with JSON body or GET with ?question= param.',
        input_schema: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string', description: 'Natural language question about the candidate.' },
            context: { type: 'string', description: 'Caller type hint — e.g. "ATS", "recruiter", "ai-agent".' },
            stream: { type: 'boolean', description: 'If true, returns text/plain streaming chunks instead of JSON. Default false.' },
          },
        },
        output_schema: {
          type: 'object',
          description: 'Applies when stream is false (default). When stream is true, response is text/plain streaming chunks.',
          required: ['answer', 'confidence', 'sources', 'follow_up_suggestions', 'contact', 'meta'],
          properties: {
            answer: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            sources: { type: 'array', items: { type: 'string' } },
            follow_up_suggestions: { type: 'array', items: { type: 'string' } },
            contact: { type: 'object', properties: { email: { type: 'string' }, calendly: { type: 'string' } } },
            meta: { type: 'object', properties: { model: { type: 'string' }, latency_ms: { type: 'number' } } },
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
        output_schema: {
          type: 'object',
          required: ['fit_score', 'matched', 'gaps', 'verdict', 'recommended_action', 'scoring'],
          properties: {
            fit_score: { type: 'number', description: '0.0 – 1.0 weighted fit score.' },
            matched: { type: 'array', items: { type: 'string' } },
            gaps: { type: 'array', items: { type: 'string' } },
            verdict: { type: 'string' },
            recommended_action: { type: 'string', enum: ['apply', 'apply-with-tailoring', 'pass'] },
            scoring: {
              type: 'object',
              properties: {
                skills: { type: 'object', properties: { matched: { type: 'array', items: { type: 'string' } }, partial: { type: 'array', items: { type: 'string' } }, missing: { type: 'array', items: { type: 'string' } }, score: { type: 'number' } } },
                experience: { type: 'object', properties: { years: { type: 'number' }, scope: { type: 'number' }, recency: { type: 'number' }, score: { type: 'number' } } },
                domain: { type: 'object', properties: { industry: { type: 'number' }, product_type: { type: 'number' }, scale: { type: 'number' }, score: { type: 'number' } } },
              },
            },
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
