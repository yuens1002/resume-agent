import { Hono } from 'hono'
import { fetchProfile } from '../lib/profile-cache.js'
import { loadPublicKeyFromEnv } from '../lib/oep-key.js'

const app = new Hono()

// A2A-compliant agent card for autodiscovery by employer AI systems
app.get('/', async (c) => {
  // Best-effort: the card renders with generic fallbacks when the profile is
  // unavailable, so autodiscovery never breaks on a data-source blip.
  const result = await fetchProfile()
  const data = result.kind === 'ok' ? result.profile : undefined

  const baseUrl = (process.env.PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, '')

  let oepIdentity: { fingerprint: string; key_url: string } | undefined
  try {
    const loaded = loadPublicKeyFromEnv()
    if (loaded) {
      oepIdentity = {
        fingerprint: loaded.fingerprint,
        key_url: `${baseUrl}/.well-known/oep-public-key.json`,
      }
    }
  } catch {
    // malformed env — omit identity rather than fail the card
  }

  c.header('Cache-Control', 'public, max-age=300')
  return c.json({
    protocolVersion: '1.0',
    url: baseUrl,
    name: data?.contact?.name ?? 'Resume Agent',
    description: 'Self-sovereign AI agent representing this professional\'s canonical profile. Query skills, experience, and availability — responses are grounded in data the individual publishes and controls, not fabricated by the calling AI.',
    version: '1.3.0',
    securitySchemes: {},
    security: [{}],
    provider: {
      organization: data?.contact?.name ?? 'Resume Agent',
      url: process.env.PROVIDER_HOMEPAGE,
      contact: data?.contact?.email,
      ...(oepIdentity ? { identity: oepIdentity } : {}),
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [
        {
          uri: `${baseUrl}/.well-known/agent-card.json#supported-interfaces`,
          description: 'Protocol bindings supported by this agent (MCP, HTTP+JSON).',
          required: false,
          params: {
            supportedInterfaces: [
              {
                url: `${baseUrl}/public-mcp`,
                protocolBinding: 'MCP',
                protocolVersion: '2025-03-26',
              },
              {
                url: baseUrl,
                protocolBinding: 'HTTP+JSON',
                protocolVersion: '1.0',
              },
            ],
          },
        },
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
              observations: { url: `${baseUrl}/observations`, method: 'GET' },
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
        description: 'Ask natural language questions about this candidate\'s skills, experience, and background. Answers are grounded in project observations and lived experience, not just resume bullets — behavioral and decision-making questions draw on the candidate\'s own captured notes about how and why they built things.',
        tags: ['resume', 'profile', 'skills', 'experience', 'behavioral'],
        examples: ['What is your experience with TypeScript?', 'How do you decide what features to build?', 'Walk me through a hard engineering tradeoff you made.'],
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
