/**
 * MCP Transport — stateless refactor acceptance tests
 *
 * Validates that the /mcp endpoint behaves as a stateless Streamable HTTP
 * transport after the session-map refactor. These tests are transport-layer
 * concerns — they do NOT depend on Supabase being reachable and do not
 * validate tool business logic (that lives in pipeline.test.ts).
 *
 * ACs validated:
 *   AC-1  No mcp-session-id issued — POST response must not set the header
 *   AC-2  Sequential independence — two POSTs succeed without sharing state
 *   AC-3  GET /mcp removed — returns 404 or 405 (no SSE stream endpoint)
 *   AC-4  DELETE /mcp removed — returns 404, 405, or 204 (no teardown endpoint)
 *   AC-5  Unauthenticated POST → 401
 *   AC-6  Invalid key POST → 401
 *   AC-7  CORS headers present on authenticated responses
 *   AC-8  Disallowed browser Origin → 403
 *   AC-9  OPTIONS preflight → 200 with CORS headers (no auth required)
 *
 * Requirements:
 *   MCP_URL        — defaults to http://localhost:3000/mcp
 *   OPEN_BRAIN_KEY — the x-brain-key value (from .env.local)
 *
 * Run (requires local server):
 *   npm run test:integration
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { config } from 'dotenv'

config({ path: '.env.local' })

const MCP_URL = process.env.MCP_URL ?? `http://localhost:${process.env.PORT ?? 3000}/mcp`
const MCP_KEY = process.env.OPEN_BRAIN_KEY

if (!MCP_KEY) throw new Error('OPEN_BRAIN_KEY must be set in .env.local')

// ── Helpers ───────────────────────────────────────────────

/** Minimal MCP tools/list call — cheap, no Supabase required. */
async function mcpPost(opts: {
  key?: string
  sessionId?: string
  origin?: string
} = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (opts.key !== undefined) headers['x-brain-key'] = opts.key
  if (opts.sessionId) headers['mcp-session-id'] = opts.sessionId
  if (opts.origin) headers['Origin'] = opts.origin

  return fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  })
}

function parseMcpBody(text: string): unknown {
  // Handle both JSON and SSE response formats
  if (text.includes('data:')) {
    const lines = text.split('\n').filter(l => l.startsWith('data:'))
    for (const line of lines.reverse()) {
      try { return JSON.parse(line.slice(5).trim()) } catch { /* skip */ }
    }
    throw new Error(`No parseable data in SSE: ${text.slice(0, 200)}`)
  }
  return JSON.parse(text)
}

// ── AC-1: No session ID issued ────────────────────────────

describe('AC-1: no mcp-session-id issued', () => {
  it('POST response must not contain mcp-session-id header', async () => {
    const res = await mcpPost({ key: MCP_KEY })
    assert.ok(res.ok, `Expected 2xx, got ${res.status}`)
    assert.equal(
      res.headers.get('mcp-session-id'),
      null,
      'Stateless server must not issue mcp-session-id',
    )
  })
})

// ── AC-2: Sequential independence ────────────────────────

describe('AC-2: sequential requests succeed without shared state', () => {
  it('first POST succeeds', async () => {
    const res = await mcpPost({ key: MCP_KEY })
    assert.ok(res.ok, `Expected 2xx, got ${res.status}`)
    const payload = parseMcpBody(await res.text()) as { result?: { tools?: unknown[] } }
    assert.ok(Array.isArray(payload?.result?.tools), 'Should return tools array')
  })

  it('second POST succeeds independently (no prior session)', async () => {
    const res = await mcpPost({ key: MCP_KEY })
    assert.ok(res.ok, `Expected 2xx, got ${res.status}`)
    const payload = parseMcpBody(await res.text()) as { result?: { tools?: unknown[] } }
    assert.ok(Array.isArray(payload?.result?.tools), 'Should return tools array')
  })

  it('POST with a stale mcp-session-id still succeeds (not rejected)', async () => {
    // In stateless mode, the server ignores any session ID the client sends
    const res = await mcpPost({ key: MCP_KEY, sessionId: 'stale-session-id-from-old-server' })
    assert.ok(res.ok, `Expected 2xx, got ${res.status}`)
  })
})

// ── AC-3: GET /mcp removed ────────────────────────────────

describe('AC-3: GET /mcp returns 404 or 405', () => {
  it('GET without session returns non-2xx', async () => {
    const res = await fetch(MCP_URL, {
      method: 'GET',
      headers: { 'x-brain-key': MCP_KEY! },
    })
    assert.ok(
      [404, 405].includes(res.status),
      `Expected 404 or 405, got ${res.status} — GET should not be a valid endpoint in stateless mode`,
    )
  })
})

// ── AC-4: DELETE /mcp removed ────────────────────────────

describe('AC-4: DELETE /mcp returns 404, 405, or 204', () => {
  it('DELETE returns a non-5xx response', async () => {
    const res = await fetch(MCP_URL, {
      method: 'DELETE',
      headers: { 'x-brain-key': MCP_KEY! },
    })
    assert.ok(
      [204, 404, 405].includes(res.status),
      `Expected 204/404/405, got ${res.status}`,
    )
  })
})

// ── AC-5: Unauthenticated POST → 401 ─────────────────────

describe('AC-5: unauthenticated requests rejected', () => {
  it('POST with no credentials returns 401', async () => {
    const res = await mcpPost()
    assert.equal(res.status, 401, 'No credentials should return 401')
  })

  it('401 response includes WWW-Authenticate header', async () => {
    const res = await mcpPost()
    const wwwAuth = res.headers.get('WWW-Authenticate')
    assert.ok(wwwAuth, 'WWW-Authenticate header should be present on 401')
    assert.match(wwwAuth, /Bearer/, 'Should indicate Bearer auth scheme')
  })
})

// ── AC-6: Invalid key → 401 ───────────────────────────────

describe('AC-6: invalid key rejected', () => {
  it('POST with wrong x-brain-key returns 401', async () => {
    const res = await mcpPost({ key: 'totally-wrong-key-xyz' })
    assert.equal(res.status, 401, 'Wrong key should return 401')
  })
})

// ── AC-7: CORS headers present ───────────────────────────

describe('AC-7: CORS headers on authenticated responses', () => {
  it('authenticated POST includes Access-Control-Allow-Origin', async () => {
    const res = await mcpPost({ key: MCP_KEY })
    assert.ok(res.ok, `Expected 2xx, got ${res.status}`)
    assert.ok(
      res.headers.get('access-control-allow-origin'),
      'CORS header Access-Control-Allow-Origin must be present',
    )
  })

  it('authenticated POST includes Access-Control-Expose-Headers', async () => {
    const res = await mcpPost({ key: MCP_KEY })
    assert.ok(
      res.headers.get('access-control-expose-headers'),
      'Access-Control-Expose-Headers must be present',
    )
  })
})

// ── AC-8: Disallowed Origin → 403 ────────────────────────

describe('AC-8: disallowed browser origin blocked', () => {
  it('POST from unlisted origin returns 403', async () => {
    const res = await mcpPost({ key: MCP_KEY, origin: 'https://evil-attacker.example.com' })
    assert.equal(
      res.status,
      403,
      'Request from unlisted browser Origin should be blocked',
    )
  })

  it('POST from allowed origin (claude.ai) succeeds', async () => {
    const res = await mcpPost({ key: MCP_KEY, origin: 'https://claude.ai' })
    assert.ok(res.ok, `claude.ai origin should be allowed, got ${res.status}`)
  })
})

// ── AC-9: OPTIONS preflight ───────────────────────────────

describe('AC-9: OPTIONS preflight returns 200 with CORS headers', () => {
  it('OPTIONS /mcp returns 200 without requiring auth', async () => {
    const res = await fetch(MCP_URL, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://claude.ai',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-brain-key, content-type',
      },
    })
    assert.equal(res.status, 200, 'OPTIONS preflight must return 200')
  })

  it('OPTIONS response includes Access-Control-Allow-Methods', async () => {
    const res = await fetch(MCP_URL, {
      method: 'OPTIONS',
      headers: { Origin: 'https://claude.ai' },
    })
    assert.ok(
      res.headers.get('access-control-allow-methods'),
      'CORS preflight must include Access-Control-Allow-Methods',
    )
  })
})
