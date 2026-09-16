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
 *   AC-10 Valid x-brain-key bypasses the shared IP rate limit (opt-in, see below)
 *   AC-11 Valid OAuth Client Credentials JWT bypasses the shared IP rate limit (opt-in, see below)
 *
 * Requirements:
 *   MCP_URL             — defaults to http://localhost:3000/mcp
 *   OPEN_BRAIN_KEY      — the x-brain-key value (from .env.local)
 *   BASE_URL            — defaults to http://localhost:<PORT> (AC-11's /token call)
 *   OAUTH_CLIENT_ID     — defaults to claude-ai-connector (AC-11); routes/oauth.ts
 *                         treats this as a comma-separated allowlist, so AC-11 uses
 *                         only the first entry as the actual client_id to authenticate as
 *   OAUTH_CLIENT_SECRET — required for AC-11's client_credentials grant
 *
 * Run (requires local server):
 *   npm run test:transport
 *
 * AC-10 and AC-11 also require TEST_RATE_LIMIT=1 to run — see those tests for why.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { config } from 'dotenv'

config({ path: '.env.local' })

const MCP_URL = process.env.MCP_URL ?? `http://localhost:${process.env.PORT ?? 3000}/mcp`
const MCP_KEY = process.env.OPEN_BRAIN_KEY
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
// routes/oauth.ts's ALLOWED_CLIENT_IDS splits this on commas — use only the first
// entry as the actual client_id, or a multi-client .env.local value fails with
// invalid_client (the raw comma-joined string is never itself a member of that set).
const OAUTH_CLIENT_ID = (process.env.OAUTH_CLIENT_ID ?? 'claude-ai-connector').split(',')[0].trim()
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET

if (!MCP_KEY) throw new Error('OPEN_BRAIN_KEY must be set in .env.local')

// ── Helpers ───────────────────────────────────────────────

/** Minimal MCP tools/list call — cheap, no Supabase required. */
async function mcpPost(opts: {
  key?: string
  token?: string
  sessionId?: string
  origin?: string
} = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (opts.key !== undefined) headers['x-brain-key'] = opts.key
  if (opts.token !== undefined) headers['Authorization'] = `Bearer ${opts.token}`
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
    assert.ok([200, 204].includes(res.status), `OPTIONS preflight must return 200 or 204, got ${res.status}`)
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

// ── AC-10: valid x-brain-key bypasses the shared IP rate limit ──
//
// Skipped by default — unlike public-mcp-transport.test.ts's AC-8 (which
// deliberately exhausts the shared bucket), a WORKING bypass here never
// touches rateLimitMap at all, so the passing case is neither
// order-dependent nor destructive. It's gated instead because a REGRESSED
// bypass burns the shared 30-req/min-per-IP bucket (src/index.ts) for the
// rest of the process — cheap insurance against a routine `npm run
// test:transport` run silently poisoning every other test in this file (it
// runs last, so nothing downstream in this file is affected, but other
// processes hitting the same server would be). Enable with TEST_RATE_LIMIT=1.
//
// Before this fix, index.ts's rate-limiter only recognized the
// `Authorization: Bearer <API_KEY>` owner bypass — a valid x-brain-key (the
// credential /mcp actually authenticates with, routes/mcp.ts's
// authenticate()) got no exemption, so every MCP tool call from an
// authenticated client counted against the same budget as anonymous
// traffic. Confirmed live 2026-09-16: a client issuing a short burst of MCP
// tool calls exhausted the window before a later call in the same run.

describe('AC-10: valid x-brain-key bypasses the shared IP rate limit', () => {
  const shouldRun = process.env.TEST_RATE_LIMIT === '1'
  const runner = shouldRun ? it : it.skip
  runner(
    '32 authenticated requests all succeed — run with TEST_RATE_LIMIT=1',
    async () => {
      for (let i = 0; i < 32; i++) {
        const res = await mcpPost({ key: MCP_KEY })
        // Assert 2xx first, not just "not 429" — a 5xx would otherwise read
        // as "bypassed" (it isn't 429), and a bad/stale OPEN_BRAIN_KEY would
        // fail every request with 401 well before request 31 trips the
        // limit, misreporting as a rate-limit failure instead of an auth one.
        assert.ok(res.ok, `Request ${i + 1}/32 with a valid x-brain-key should succeed, got ${res.status}`)
        assert.ok(
          res.status !== 429,
          `Request ${i + 1}/32 with a valid x-brain-key should bypass the rate limit, got 429`,
        )
      }
      console.warn('AC-10: x-brain-key bypass verified across 32 requests.')
    },
  )
})

// ── AC-11: valid OAuth Client Credentials JWT bypasses the shared IP rate limit ──
//
// Gated the same way as AC-10 (see above), but for a different reason: this
// test's own /token client_credentials call carries no owner credential, so —
// unlike AC-10, which is neither order-dependent nor destructive — it DOES
// count one request against the shared 30-req/min-per-IP bucket every time it
// runs. That makes AC-11 order-dependent on prior anonymous traffic in this
// same process (including AC-5/AC-6's unauthenticated requests earlier in
// this file, and a REGRESSED AC-10 immediately before it): a 429 from the
// /token call below means the bucket was already near its limit, not that
// this fix has a problem. Enable with TEST_RATE_LIMIT=1.
//
// This is the credential AC-10 didn't cover: authenticate() (routes/mcp.ts)
// has always accepted any access token /token (routes/oauth.ts) issues —
// including, but not limited to, the client_credentials grant used here — via
// `Authorization: Bearer <token>`, as well as x-brain-key, but until
// src/lib/mcp-auth.ts's isOwnerRequest() was shared with index.ts's
// rate-limiter, only x-brain-key got the bypass — a client authenticating via
// the JWT path still counted against the same anonymous budget as
// unauthenticated traffic.

describe('AC-11: valid OAuth Client Credentials JWT bypasses the shared IP rate limit', () => {
  const shouldRun = process.env.TEST_RATE_LIMIT === '1'
  const runner = shouldRun ? it : it.skip
  runner(
    '32 authenticated requests all succeed — run with TEST_RATE_LIMIT=1',
    async () => {
      if (!OAUTH_CLIENT_SECRET) throw new Error('OAUTH_CLIENT_SECRET must be set in .env.local to run AC-11')

      const tokenRes = await fetch(`${BASE_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: OAUTH_CLIENT_ID,
          client_secret: OAUTH_CLIENT_SECRET,
        }).toString(),
      })
      const tokenText = await tokenRes.text()
      let tokenBody: { access_token?: string }
      try {
        tokenBody = JSON.parse(tokenText) as { access_token?: string }
      } catch {
        assert.fail(`client_credentials grant returned non-JSON, got ${tokenRes.status}: ${tokenText.slice(0, 200)}`)
      }
      assert.equal(tokenRes.status, 200, `client_credentials grant should succeed, got ${tokenRes.status}: ${JSON.stringify(tokenBody)}`)
      assert.ok(tokenBody.access_token, 'No access_token in client_credentials response')

      for (let i = 0; i < 32; i++) {
        const res = await mcpPost({ token: tokenBody.access_token })
        // Assert 2xx first, not just "not 429" — same reasoning as AC-10: a
        // 5xx would otherwise read as "bypassed" since it isn't 429 either.
        assert.ok(res.ok, `Request ${i + 1}/32 with a valid OAuth JWT should succeed, got ${res.status}`)
        assert.ok(
          res.status !== 429,
          `Request ${i + 1}/32 with a valid OAuth JWT should bypass the rate limit, got 429`,
        )
      }
      console.warn('AC-11: OAuth Client Credentials JWT bypass verified across 32 requests.')
    },
  )
})
