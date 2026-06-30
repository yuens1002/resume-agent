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
                      project_slugs: { type: 'array', items: { type: 'string' } },
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
                      tagline: { type: 'string', description: 'Short identity tagline shown under the candidate\'s name. Optional — falls back to preferred_roles when absent.' },
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
                        role: { type: 'string' },
                        tech: { type: 'array', items: { type: 'string' } },
                        status: { type: 'string' },
                        started: { type: 'string' },
                        url: { type: 'string', format: 'uri' },
                        repo: { type: 'string', format: 'uri' },
                        cover: { type: 'string', format: 'uri' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/observations': {
        get: {
          operationId: 'listObservations',
          summary: 'Browse the candidate\'s authored reasoning/premise trail',
          description: 'Returns public-eligible OB1 observations — the dated, authored "why and lessons" notes behind the profile (types observation/idea/task), each with a stable URL for citation. Excludes the git-sync changelog ledger (type=reference) by default; pass type=reference to read it. Private notes are always excluded.',
          parameters: [
            { name: 'topic', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by an OB1 topic tag (case-insensitive)' },
            { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['observation', 'idea', 'task', 'reference'] }, description: 'Override the default type filter (observation/idea/task). Use "reference" for the git/changelog ledger.' },
            { name: 'since', in: 'query', required: false, schema: { type: 'string', format: 'date' }, description: 'Only observations on or after this date (YYYY-MM-DD)' },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
          ],
          responses: {
            '200': {
              description: 'A list of public-eligible observations, each individually addressable',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      count: { type: 'integer' },
                      scope: { type: 'object', description: 'The active topic scope: {topic}, {topics}, or {recent:true}' },
                      types: { type: 'array', items: { type: 'string' }, description: 'The thought types included (default observation/idea/task, or the explicit ?type)' },
                      note: { type: 'string', description: 'Human-readable description of what this surface returns' },
                      observations: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            date: { type: 'string', format: 'date' },
                            type: { type: 'string' },
                            topics: { type: 'array', items: { type: 'string' } },
                            content: { type: 'string' },
                            url: { type: 'string', format: 'uri', description: 'Stable URL for this observation (GET returns the single record)' },
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
      },
    },
  })
})

export default app
