/**
 * Public MCP Transport — acceptance tests for /public-mcp
 *
 * Covers AC-1 through AC-8 from docs/plans/public-mcp-query-only.md.
 * Transport-layer only; no Supabase, no LLM access required.
 *
 * Requirements:
 *   PUBLIC_MCP_URL (defaults to http://localhost:${PORT ?? 3000}/public-mcp)
 *
 * Run (requires local server):
 *   npm run test:public-mcp
 *
 * AC-8 (rate-limit) is skipped by default — the shared 30-req/min bucket
 * makes it order-dependent and destructive to parallel runs. Enable with
 * TEST_RATE_LIMIT=1 to opt in.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { config } from 'dotenv'
import {
  publicMcpPost,
  publicMcpToolsList,
  PUBLIC_MCP_URL,
} from './helpers/public-mcp.js'

config({ path: '.env.local' })

// ── AC-1: POST /public-mcp without credentials returns 2xx ───

describe('AC-1: POST /public-mcp without credentials returns 2xx', () => {
  it('tools/list succeeds with no auth header', async () => {
    const res = await publicMcpToolsList()
    assert.ok(res.ok, `Expected 2xx, got ${res.status}`)
  })
})

// ── AC-2: no mcp-session-id header ───────────────────────────

describe('AC-2: POST /public-mcp response — no mcp-session-id header', () => {
  it('response does not include mcp-session-id header', async () => {
    const res = await publicMcpToolsList()
    assert.equal(
      res.headers.get('mcp-session-id'),
      null,
      'Stateless public MCP must not issue mcp-session-id',
    )
  })
})

// ── AC-3: GET /public-mcp — descriptor, or 405 for an SSE client ──
//
// Was "returns 404" until #223. The endpoint is advertised in llms.txt, so a
// bare 404 was what crawlers following it got; a plain GET now returns the
// self-descriptor instead. A client asking for the server→client SSE stream
// still gets the spec's 405, which is what the old 404 stood in for.

describe('AC-3: GET /public-mcp returns a self-descriptor', () => {
  it('plain GET returns 200 with the endpoint descriptor', async () => {
    const res = await fetch(PUBLIC_MCP_URL, { method: 'GET' })
    assert.equal(res.status, 200, `Expected 200 descriptor, got ${res.status}`)
    const body = (await res.json()) as { method?: string; tools?: Array<{ name?: string }> }
    assert.equal(body.method, 'POST')
    assert.equal(body.tools?.[0]?.name, 'ask_candidate')
  })

  it('GET with Accept: text/event-stream returns 405 + Allow: POST (no SSE stream endpoint)', async () => {
    const res = await fetch(PUBLIC_MCP_URL, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    })
    assert.equal(res.status, 405, `Expected 405, got ${res.status}`)
    assert.equal(res.headers.get('allow'), 'POST')
  })
})

// ── AC-4: DELETE /public-mcp returns 404 ─────────────────────

describe('AC-4: DELETE /public-mcp returns 404', () => {
  it('DELETE returns 204, 404, or 405', async () => {
    const res = await fetch(PUBLIC_MCP_URL, { method: 'DELETE' })
    assert.ok(
      [204, 404, 405].includes(res.status),
      `Expected 204/404/405, got ${res.status}`,
    )
  })
})

// ── AC-5: CORS headers present ───────────────────────────────

describe('AC-5: CORS headers present on responses', () => {
  it('authenticated POST includes Access-Control-Allow-Origin', async () => {
    const res = await publicMcpToolsList()
    assert.ok(res.ok, `Expected 2xx, got ${res.status}`)
    assert.ok(
      res.headers.get('access-control-allow-origin'),
      'Access-Control-Allow-Origin must be present',
    )
  })
})

// ── AC-6: Disallowed browser origin → 403 ────────────────────

describe('AC-6: disallowed browser origin blocked', () => {
  it('POST from unlisted origin returns 403', async () => {
    const res = await publicMcpPost({ origin: 'https://evil-attacker.example.com' })
    assert.equal(
      res.status,
      403,
      'Request from unlisted browser Origin should be blocked',
    )
  })

  it('POST from claude.ai origin is NOT blocked by origin check', async () => {
    // Use tools/list to avoid invoking the LLM just to test origin
    const res = await fetch(PUBLIC_MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Origin: 'https://claude.ai',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    })
    assert.notEqual(res.status, 403, 'claude.ai should be an allowed origin')
  })
})

// ── AC-7: OPTIONS preflight ──────────────────────────────────

describe('AC-7: OPTIONS preflight returns 200/204 with CORS headers', () => {
  it('OPTIONS without auth returns 200 or 204', async () => {
    const res = await fetch(PUBLIC_MCP_URL, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://claude.ai',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    assert.ok(
      [200, 204].includes(res.status),
      `OPTIONS must return 200 or 204, got ${res.status}`,
    )
  })

  it('OPTIONS response includes Access-Control-Allow-Methods', async () => {
    const res = await fetch(PUBLIC_MCP_URL, {
      method: 'OPTIONS',
      headers: { Origin: 'https://claude.ai' },
    })
    assert.ok(
      res.headers.get('access-control-allow-methods'),
      'Access-Control-Allow-Methods must be present on preflight',
    )
  })
})

// ── AC-8: rate limit (skipped by default) ────────────────────

describe('AC-8: rate limit applies — 31st request returns 429', () => {
  const shouldRun = process.env.TEST_RATE_LIMIT === '1'
  const runner = shouldRun ? it : it.skip
  runner(
    'exhausts shared 30-req/min bucket and expects 429 — run with TEST_RATE_LIMIT=1',
    async () => {
      let lastStatus = 200
      for (let i = 0; i < 32; i++) {
        const res = await publicMcpToolsList()
        lastStatus = res.status
        if (lastStatus === 429) break
      }
      assert.equal(
        lastStatus,
        429,
        `Expected 429 after exhausting shared rate-limit bucket, got ${lastStatus}`,
      )
      console.warn('AC-8: rate-limit verified. Shared bucket is now exhausted for ~60s.')
    },
  )
})
