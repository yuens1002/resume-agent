import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  const baseUrl = (process.env.PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, '')

  c.header('Cache-Control', 'public, max-age=3600')
  return c.json({
    openapi: '3.1.0',
    info: {
      title: 'Resume Agent API',
      description: 'Query a candidate\'s professional profile. Use queryProfile for natural language questions, matchJob to score against a job description, and the GET endpoints for structured profile data.',
      version: '1.0.0',
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/query': {
        post: {
          operationId: 'queryProfile',
          summary: 'Ask a question about the candidate',
          description: 'Ask any natural language question about the candidate\'s skills, experience, projects, background, or behavioral tendencies. Use this for conversational questions like "What is your TypeScript experience?" or "How do you approach testing?"',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['question'],
                  properties: {
                    question: {
                      type: 'string',
                      description: 'The question to ask about the candidate',
                    },
                    context: {
                      type: 'string',
                      description: 'Optional extra context (e.g. role being hired for)',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Answer grounded in the candidate\'s profile data',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      answer: { type: 'string' },
                      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                      sources: { type: 'array', items: { type: 'string' } },
                      follow_up_suggestions: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/match': {
        post: {
          operationId: 'matchJob',
          summary: 'Score the candidate against a job description',
          description: 'Paste a job description to get a structured fit score. Returns a percentage score, matched skills, gaps, and a hiring recommendation. Use this when the user shares a role they\'re considering.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['job_description'],
                  properties: {
                    job_description: {
                      type: 'string',
                      description: 'The full job description text',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Fit score and breakdown',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      fit_score: { type: 'number', description: 'Overall fit percentage 0–100' },
                      matched: { type: 'array', items: { type: 'string' }, description: 'Skills and experience that match' },
                      gaps: { type: 'array', items: { type: 'string' }, description: 'Missing or weak areas' },
                      verdict: { type: 'string' },
                      recommended_action: { type: 'string', enum: ['apply', 'apply-with-tailoring', 'pass'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/info': {
        get: {
          operationId: 'getProfile',
          summary: 'Get the full candidate profile',
          description: 'Returns the complete structured profile including contact info, summary, all skills, full employment history, education, and all portfolio projects. Use when you need comprehensive profile data.',
          responses: {
            '200': {
              description: 'Full public profile',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      contact: { type: 'object' },
                      summary: { type: 'string' },
                      skills: { type: 'array' },
                      employment: { type: 'array' },
                      education: { type: 'array' },
                      projects: { type: 'array' },
                      availability: { type: 'object' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/availability': {
        get: {
          operationId: 'getAvailability',
          summary: 'Get current availability and preferred roles',
          description: 'Returns whether the candidate is currently seeking work, their availability status, and preferred roles and locations. Use when asked "Are you open to work?" or "What roles are you looking for?"',
          responses: {
            '200': {
              description: 'Availability status',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      seeking: { type: 'boolean' },
                      status: { type: 'string', enum: ['open', 'actively-looking', 'not-looking'] },
                      preferred_roles: { type: 'array', items: { type: 'string' } },
                      remote: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/projects': {
        get: {
          operationId: 'listProjects',
          summary: 'List portfolio projects',
          description: 'Returns a summary list of all portfolio projects with name, description, tech stack, and status. Use when asked about projects or portfolio work.',
          responses: {
            '200': {
              description: 'Project list',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        slug: { type: 'string' },
                        description: { type: 'string' },
                        tech: { type: 'array', items: { type: 'string' } },
                        status: { type: 'string' },
                        url: { type: 'string' },
                        repo: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
})

export default app
