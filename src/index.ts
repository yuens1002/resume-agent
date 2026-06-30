import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { timingSafeEqual } from './lib/crypto.js'

import infoRoute from './routes/info.js'
import availabilityRoute from './routes/availability.js'
import queryRoute from './routes/query.js'
import matchRoute from './routes/match.js'
import resumeRoute from './routes/resume.js'
import agentCardRoute from './routes/agent-card.js'
import openApiRoute from './routes/openapi.js'
import qrRoute from './routes/qr.js'
import verifyRoute from './routes/verify.js'
import profileRoute from './routes/profile.js'
import projectsRoute from './routes/projects.js'
import observationsRoute from './routes/observations.js'
import mcpRoute from './routes/mcp.js'
import publicMcpRoute from './routes/public-mcp.js'
import oauthRoute from './routes/oauth.js'
import oepRoute from './routes/oep.js'


const app = new Hono({ strict: false })

app.use('*', logger())
app.use('*', cors())

// IP-based rate limiting: 30 requests per minute per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

// Evict expired entries every 5 minutes to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now()
  for (const [key, record] of rateLimitMap) {
    if (now > record.resetAt) rateLimitMap.delete(key)
  }
}, 5 * 60_000)

const getClientIp = (c: Context): string => {
  for (const header of ['cf-connecting-ip', 'x-real-ip', 'x-client-ip', 'true-client-ip'] as const) {
    const value = c.req.header(header)
    if (value) return value
  }
  const xff = c.req.header('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return `${c.req.header('host') ?? 'unknown-host'}:${c.req.header('user-agent') ?? 'unknown-ua'}`
}

app.use('*', async (c, next) => {
  // Skip OPTIONS preflights and health checks — don't count toward the rate limit
  if (c.req.method === 'OPTIONS' || c.req.path === '/health') return next()

  // Owner bypass — valid API_KEY skips rate limiting entirely
  const authHeader = c.req.header('Authorization') ?? ''
  const match = /^bearer\s+(.+)$/i.exec(authHeader)
  const apiKey = process.env.API_KEY
  if (match && apiKey && timingSafeEqual(match[1], apiKey)) return next()

  const ip = getClientIp(c)
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

app.onError((err, c) => {
  console.error('[app] unhandled error:', err instanceof Error ? err.message : err)
  return c.json({ error: 'Internal server error' }, 500)
})

app.route('/info', infoRoute)
app.route('/availability', availabilityRoute)
app.route('/query', queryRoute)
app.route('/match', matchRoute)
app.route('/resume', resumeRoute)
app.route('/.well-known/agent-card.json', agentCardRoute)
app.route('/.well-known/agent-card', agentCardRoute)
app.get('/.well-known/agent.json', (c) => c.redirect('/.well-known/agent-card.json', 301))
app.route('/.well-known/oep-public-key.json', oepRoute)
app.get('/try', (c) => c.redirect('/query?question=Tell+me+about+yourself&stream=true', 302))

app.get('/robots.txt', (c) =>
  c.text(
    [
      'User-agent: *',
      'Allow: /',
      '',
      '# AI assistants — explicitly welcome',
      'User-agent: GPTBot',
      'User-agent: ChatGPT-User',
      'User-agent: Google-Extended',
      'User-agent: PerplexityBot',
      'User-agent: ClaudeBot',
      'User-agent: anthropic-ai',
      'User-agent: Grok',
      'User-agent: YouBot',
      'User-agent: cohere-ai',
      'Allow: /',
    ].join('\n'),
  ),
)
app.route('/profile', profileRoute)
app.route('/projects', projectsRoute)
app.route('/observations', observationsRoute)
app.route('/mcp', mcpRoute)
app.route('/public-mcp', publicMcpRoute)
app.route('/', oauthRoute)

app.route('/verify', verifyRoute)
app.get('/health', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ status: 'ok' })
})
app.route('/openapi.json', openApiRoute)
app.route('/qr', qrRoute)
app.route('/', agentCardRoute)

const port = parseInt(process.env.PORT ?? '3000')

serve({ fetch: app.fetch, port }, () => {
  const authMode = process.env.AUTH_MODE ?? 'open'
  console.log(`resume-agent running on http://localhost:${port}`)
  console.log('[routes] GET /, /health, /openapi.json, /qr, /info, /availability, /projects, /projects/:slug, /observations, /observations/:id, /try, /.well-known/agent-card.json, /.well-known/agent-card (agent.json → 301)')
  console.log(`[routes] POST /query, /match | POST /resume (auth: ${authMode}) | PATCH /profile (auth: key)`)
  console.log('[middleware] rate-limit: 30 req/min per IP (excludes OPTIONS, /health)')
})
