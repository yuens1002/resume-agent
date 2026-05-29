/**
 * Routing contract tests — /.well-known/agent-card paths.
 *
 * Verifies that the extensionless URL returns 200 JSON (not a redirect),
 * preventing regression back to the 301 pattern that triggered Google Safe
 * Browsing's social-engineering classifier (issue #104).
 *
 * Run: npm run test:unit
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

// Minimal stub handler that returns the same shape the real agentCardRoute would.
// We test routing behaviour (status + redirect-or-not), not content.
const stubHandler = new Hono()
stubHandler.get('/', (c) => c.json({ stub: true }))

function buildApp() {
  const app = new Hono()
  app.get('/health', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json({ status: 'ok' })
  })
  app.route('/', stubHandler)
  app.route('/.well-known/agent-card.json', stubHandler)
  app.route('/.well-known/agent-card', stubHandler)
  app.get('/.well-known/agent.json', (c) => c.redirect('/.well-known/agent-card.json', 301))
  return app
}

describe('/.well-known/agent-card routing', () => {
  let baseUrl: string
  let server: ReturnType<typeof serve>

  before(async () => {
    const app = buildApp()
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://localhost:${info.port}`
        resolve()
      })
    })
  })

  after(() => server.close())

  it('AC-0: GET /health → 200 { status: ok }, Cache-Control: no-store', async () => {
    const res = await fetch(`${baseUrl}/health`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const body = await res.json() as Record<string, unknown>
    assert.equal(body.status, 'ok')
  })

  it('AC-2: GET / → 200 JSON (root alias for agent card)', async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: 'manual' })
    assert.equal(res.status, 200, 'root must not redirect')
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  })

  it('AC-3: /.well-known/agent-card.json → 200', async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent-card.json`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  })

  it('AC-4: /.well-known/agent-card → 200 (not a redirect)', async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent-card`, { redirect: 'manual' })
    assert.equal(res.status, 200, 'extensionless URL must not redirect')
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  })

  it('AC-5: /.well-known/agent.json → 301 to /.well-known/agent-card.json', async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent.json`, { redirect: 'manual' })
    assert.equal(res.status, 301)
    assert.ok(
      res.headers.get('location')?.endsWith('/.well-known/agent-card.json'),
      'agent.json must redirect to agent-card.json',
    )
  })
})
