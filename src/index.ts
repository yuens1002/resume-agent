import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import infoRoute from './routes/info.js'
import availabilityRoute from './routes/availability.js'
import queryRoute from './routes/query.js'
import matchRoute from './routes/match.js'
import resumeRoute from './routes/resume.js'
import agentCardRoute from './routes/agent-card.js'
import profileRoute from './routes/profile.js'
import projectsRoute from './routes/projects.js'

const app = new Hono({ strict: false })

app.use('*', logger())
app.use('*', cors())

// IP-based rate limiting: 30 requests per minute per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
app.use('*', async (c, next) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
  const now = Date.now()
  const windowMs = 60_000
  const limit = 30

  const record = rateLimitMap.get(ip)
  if (!record || now > record.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs })
  } else {
    record.count++
    if (record.count > limit) {
      return c.json({ error: 'Rate limit exceeded. Try again in a minute.' }, 429)
    }
  }
  await next()
})

app.route('/info', infoRoute)
app.route('/availability', availabilityRoute)
app.route('/query', queryRoute)
app.route('/match', matchRoute)
app.route('/resume', resumeRoute)
app.route('/.well-known/agent.json', agentCardRoute)
app.route('/profile', profileRoute)
app.route('/projects', projectsRoute)

app.get('/', (c) => c.json({ status: 'ok', agent: 'resume-agent' }))

const port = parseInt(process.env.PORT ?? '3000')

serve({ fetch: app.fetch, port }, () => {
  console.log(`resume-agent running on http://localhost:${port}`)
  console.log('[routes] GET /info, /availability, /projects, /.well-known/agent.json')
  console.log('[routes] POST /query, /match, /resume (key-protected) | PATCH /profile (key-protected)')
  console.log('[middleware] rate-limit: 30 req/min per IP')
})
