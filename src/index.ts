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

app.route('/info', infoRoute)
app.route('/availability', availabilityRoute)
app.route('/query', queryRoute)
app.route('/match', matchRoute)
app.route('/resume', resumeRoute)
app.route('/.well-known/agent-card.json', agentCardRoute)
app.route('/profile', profileRoute)
app.route('/projects', projectsRoute)

app.get('/', (c) => c.json({ status: 'ok', agent: 'resume-agent' }))

const port = parseInt(process.env.PORT ?? '3000')

serve({ fetch: app.fetch, port }, () => {
  console.log(`resume-agent running on http://localhost:${port}`)
  console.log('[routes] registered and listening — GET+POST /query, /match, /info, /availability, /resume, /profile, /projects, /.well-known/agent-card.json')
})
