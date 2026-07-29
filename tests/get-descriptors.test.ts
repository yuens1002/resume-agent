/**
 * GET self-descriptors for the advertised POST-only endpoints (#223).
 *
 * `llms.txt` advertises `POST /query`, `POST /match`, and the `/public-mcp` MCP
 * endpoint, and `robots.txt` invites crawlers — so all three get fetched with a
 * GET. `/query` has always answered with a descriptor; `/match` and
 * `/public-mcp` used to return a bare 404. These tests pin the contract:
 *
 *   - all three answer a plain GET with a self-descriptor
 *   - `/public-mcp` still gives a real MCP client (Accept: text/event-stream)
 *     the spec's 405 + Allow: POST, since this server offers no GET SSE stream
 *
 * No database, no model call — every assertion is on a handler that returns
 * before touching either. Dummy env is set first so importing the routes
 * (which pull in the supabase and model clients at module load) doesn't throw.
 *
 * Run: npm run test:unit
 */

process.env.SUPA_PROJECT_URL ??= 'http://localhost:54321'
process.env.SUPA_SERVICE_ROLE ??= 'test-dummy-key'
process.env.OPENROUTER_API_KEY ??= 'test-dummy-key'

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

let baseUrl: string
let server: ReturnType<typeof serve>

before(async () => {
  const [{ default: matchRoute }, { default: publicMcpRoute }, { default: queryRoute }] =
    await Promise.all([
      import('../src/routes/match.js'),
      import('../src/routes/public-mcp.js'),
      import('../src/routes/query.js'),
    ])
  const app = new Hono({ strict: false })
  app.route('/match', matchRoute)
  app.route('/public-mcp', publicMcpRoute)
  app.route('/query', queryRoute)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://localhost:${info.port}`
      resolve()
    })
  })
})

after(() => server.close())

describe('GET /match — self-descriptor', () => {
  it('returns 200 with the same descriptor shape as GET /query', async () => {
    const res = await fetch(`${baseUrl}/match`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)

    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.endpoint, '/match')
    assert.equal(body.method, 'POST')
    assert.ok(typeof body.description === 'string' && body.description.length > 0)
    // The one required field a caller has to know about
    assert.ok((body.body as Record<string, unknown>).job_description)
    assert.ok((body.example as Record<string, unknown>).job_description)
  })

  it('does not shadow POST /match', async () => {
    // Empty body → the zod validator rejects it. The point is that the request
    // reached the POST handler at all rather than being swallowed by the GET route.
    const res = await fetch(`${baseUrl}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400)
  })
})

describe('GET /public-mcp — descriptor for crawlers, 405 for MCP clients', () => {
  it('returns 200 with a descriptor naming the transport, the tool, and its arguments', async () => {
    const res = await fetch(`${baseUrl}/public-mcp`)
    assert.equal(res.status, 200)

    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.endpoint, '/public-mcp')
    assert.equal(body.method, 'POST')
    assert.match(String(body.transport), /MCP/)
    assert.match(String(body.protocol), /JSON-RPC/)

    const tools = body.tools as Array<Record<string, unknown>>
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'ask_candidate')
    // The argument shape is the thing an agent needs before it can call
    assert.ok((tools[0].arguments as Record<string, unknown>).question)
  })

  it('serves the descriptor to a browser Accept header', async () => {
    const res = await fetch(`${baseUrl}/public-mcp`, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    })
    assert.equal(res.status, 200)
  })

  it('returns 405 + Allow: POST when an MCP client asks for the SSE stream', async () => {
    const res = await fetch(`${baseUrl}/public-mcp`, {
      headers: { Accept: 'text/event-stream' },
    })
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('allow'), 'POST')

    // The 405 is still informative — same descriptor, plus why it was refused
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.method, 'POST')
    assert.ok((body.tools as unknown[]).length > 0)
    assert.match(String(body.error), /Method Not Allowed/)
  })

  it('returns 405 for the combined Accept header MCP clients commonly send', async () => {
    const res = await fetch(`${baseUrl}/public-mcp`, {
      headers: { Accept: 'application/json, text/event-stream' },
    })
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('allow'), 'POST')
  })

  it('advertises the tool this server actually registers, not a stale copy', async () => {
    // The invariant, not the literal. Both sides of this comparison are read at
    // runtime: the descriptor from GET, the registration from a real tools/list
    // round-trip through the MCP transport. Asserting `name === 'ask_candidate'`
    // on the descriptor alone would stay green after a rename of the registered
    // tool, leaving the descriptor advertising a name that fails at call time —
    // the failure this endpoint exists to prevent.
    //
    // tools/list is a protocol call, not a tool invocation: no model, no DB.
    const res = await fetch(`${baseUrl}/public-mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    assert.ok(res.ok, `tools/list should succeed, got ${res.status}`)

    // The transport answers as SSE — pull the JSON out of the data: frame.
    const raw = await res.text()
    const payload = JSON.parse(raw.slice(raw.indexOf('{"result"')))
    const registered = payload.result.tools as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>

    const descriptor = (await (await fetch(`${baseUrl}/public-mcp`)).json()) as {
      tools: Array<{ name: string; arguments: Record<string, unknown> }>
    }

    assert.deepEqual(
      descriptor.tools.map((t) => t.name),
      registered.map((t) => t.name),
      'descriptor must advertise exactly the registered tool set',
    )

    // Same trap one level down: the descriptor restates the argument shape in
    // prose, so a zod schema change would leave it describing arguments the
    // tool no longer takes. Compare the key sets.
    assert.deepEqual(
      Object.keys(descriptor.tools[0].arguments).sort(),
      Object.keys(registered[0].inputSchema?.properties ?? {}).sort(),
      'descriptor argument names must match the tool inputSchema',
    )
  })

  it('carries CORS headers and still enforces the origin allowlist', async () => {
    const ok = await fetch(`${baseUrl}/public-mcp`)
    assert.ok(ok.headers.get('access-control-allow-origin'), 'CORS header must be present')
    assert.match(ok.headers.get('access-control-allow-methods') ?? '', /GET/)

    const blocked = await fetch(`${baseUrl}/public-mcp`, {
      headers: { Origin: 'https://evil-attacker.example.com' },
    })
    assert.equal(blocked.status, 403, 'GET must not bypass the DNS-rebinding origin check')
  })
})

describe('GET /query — unchanged descriptor (the pattern the other two now follow)', () => {
  it('still returns 200 with endpoint/method/body/example', async () => {
    const res = await fetch(`${baseUrl}/query`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.endpoint, '/query')
    assert.equal(body.method, 'POST')
    assert.ok((body.body as Record<string, unknown>).question)
  })
})
