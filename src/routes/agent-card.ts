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

  const baseUrl = process.env.PUBLIC_URL ?? new URL(c.req.url).origin

  return c.json({
    name: data?.contact?.name ?? 'Resume Agent',
    description: 'AI agent representing a professional profile. Query skills, experience, and availability.',
    version: '1.0.0',
    supportedInterfaces: [
      {
        url: baseUrl,
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '1.0',
      },
    ],
    provider: {
      organization: data?.contact?.name ?? 'Resume Agent',
      url: process.env.PROVIDER_HOMEPAGE,
      contact: data?.contact?.email,
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [
        {
          uri: `${baseUrl}/.well-known/agent-card.json#api-docs`,
          description: 'Custom API documentation, rate limits, and contact metadata.',
          required: false,
          params: {
            rate_limits: { requests_per_minute: 30, scope: 'per_ip' },
            contact: {
              email: data?.contact?.email,
              calendly: data?.contact?.calendly,
            },
            endpoints: {
              info: { url: `${baseUrl}/info`, method: 'GET' },
              availability: { url: `${baseUrl}/availability`, method: 'GET' },
              query: { url: `${baseUrl}/query`, method: 'POST' },
              match: { url: `${baseUrl}/match`, method: 'POST' },
              projects: { url: `${baseUrl}/projects`, method: 'GET' },
            },
          },
        },
      ],
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [
      {
        id: 'query',
        name: 'Query Profile',
        description: 'Ask natural language questions about this candidate\'s skills, experience, and background.',
        tags: ['resume', 'profile', 'skills', 'experience'],
        examples: ['What is your experience with TypeScript?', 'How many years of frontend experience do you have?'],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json', 'text/plain'],
      },
      {
        id: 'match',
        name: 'Job Match',
        description: 'Score this candidate against a job description and return a fit breakdown.',
        tags: ['matching', 'job-fit', 'scoring'],
        examples: ['Senior frontend engineer, React, TypeScript, 5+ years.'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'info',
        name: 'Profile Info',
        description: 'Returns full profile data including skills, employment, education, and projects.',
        tags: ['profile', 'resume', 'info'],
        examples: [],
        inputModes: [],
        outputModes: ['application/json'],
      },
      {
        id: 'availability',
        name: 'Availability',
        description: 'Returns current availability status and preferred roles.',
        tags: ['availability', 'status'],
        examples: [],
        inputModes: [],
        outputModes: ['application/json'],
      },
      {
        id: 'projects',
        name: 'Portfolio Projects',
        description: 'Returns all portfolio projects with tech stack, highlights, and architecture.',
        tags: ['projects', 'portfolio'],
        examples: [],
        inputModes: [],
        outputModes: ['application/json'],
      },
    ],
  })
})

export default app
