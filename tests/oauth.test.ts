/**
 * OAuth endpoint tests — refresh token flow
 *
 * Validates the full OAuth lifecycle that the Claude connector depends on:
 *   AC-1  Metadata advertises refresh_token in grant_types_supported
 *   AC-1b Metadata advertises client_secret_post in token_endpoint_auth_methods_supported
 *   AC-2  authorization_code exchange returns a refresh_token
 *   AC-3  refresh_token grant returns a new access_token + rotated refresh_token
 *   AC-4  old refresh_token is rejected after rotation (one-time use)
 *   AC-5  Expired / unknown refresh_token → 400 invalid_grant
 *   AC-6  client_id mismatch on refresh → 400 invalid_grant
 *   AC-7  access_token from refresh is valid JWT with correct sub
 *   AC-8  replaying a used refresh_token revokes all tokens for that client (reuse detection)
 *   AC-9  a non-string client_secret in a JSON body never crashes /token (400/401, not 500) — client_credentials and authorization_code
 *   AC-10 authorization_code grant with no client_secret → 401 invalid_client (closes #273)
 *   AC-11 authorization_code grant with the wrong client_secret → 401 invalid_client
 *   AC-12 refresh_token grant with no client_secret → 401 invalid_client (closes #277)
 *   AC-13 refresh_token grant with the wrong client_secret → 401 invalid_client
 *   AC-14 refresh_token grant with no client_id → 400 invalid_request
 *   AC-15 rotate_refresh_token RPC: a null p_client_id no longer bypasses the ownership
 *         check (direct RPC call, bypassing the /token handler's own now-mandatory
 *         client_id — defense in depth for any future caller that doesn't go through it)
 *
 * Requirements (in .env.local):
 *   BASE_URL            — defaults to http://localhost:<PORT>
 *   OAUTH_CLIENT_ID     — defaults to claude-ai-connector
 *   OAUTH_CLIENT_SECRET — required; the authorization_code (#273) and refresh_token (#277)
 *                         grants both validate it
 *   JWT_SECRET          — used to verify returned JWTs
 *
 * Run (requires local server with Supabase):
 *   npm run test:oauth
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { config } from 'dotenv'
import { jwtVerify } from 'jose'
import { supabase } from '../src/lib/supabase.js'

config({ path: '.env.local' })

const BASE_URL = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
// routes/oauth.ts's ALLOWED_CLIENT_IDS splits this on commas — use only the first entry as the
// actual client_id, or a multi-client .env.local value makes /authorize 400 unauthorized_client
// before any of this file's tests ever reach the client_secret check (see mcp-transport.test.ts's
// own OAUTH_CLIENT_ID handling, which this mirrors).
const CLIENT_ID = (process.env.OAUTH_CLIENT_ID ?? 'claude-ai-connector').split(',')[0].trim()
// Must match ALLOWED_REDIRECT_URIS in oauth.ts
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in .env.local')

// Unlike OAUTH_CLIENT_ID (a comma-separated allowlist in routes/oauth.ts), the route reads
// OAUTH_CLIENT_SECRET as a single opaque value with no splitting — so no equivalent handling here.
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET
if (!OAUTH_CLIENT_SECRET) throw new Error('OAUTH_CLIENT_SECRET must be set in .env.local')

// This suite's own request volume (authorize + token + differential-pair retries, several
// times over) can exceed the shared 30-req/min-per-IP rate limit on its own — x-brain-key
// bypasses that limiter globally (index.ts), and neither /authorize nor /token look at it
// for their own auth decisions, so sending it here only prevents self-inflicted 429s.
const OPEN_BRAIN_KEY = process.env.OPEN_BRAIN_KEY
if (!OPEN_BRAIN_KEY) throw new Error('OPEN_BRAIN_KEY must be set in .env.local')

function buildPKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** GET /authorize with PKCE — redirect: 'manual', extracts code from Location header */
async function authorize(clientId = CLIENT_ID): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = buildPKCE()
  const url = new URL(`${BASE_URL}/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', 'test-state')

  const res = await fetch(url.toString(), { redirect: 'manual', headers: { 'x-brain-key': OPEN_BRAIN_KEY } })
  assert.equal(res.status, 302, `Expected 302, got ${res.status}`)

  const location = res.headers.get('location')
  assert.ok(location, 'Missing Location header')

  const redirected = new URL(location)
  const code = redirected.searchParams.get('code')
  assert.ok(code, 'No code in redirect Location')

  return { code, verifier }
}

/** POST /token as application/x-www-form-urlencoded */
async function postToken(params: Record<string, string>): Promise<Response> {
  return fetch(`${BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-brain-key': OPEN_BRAIN_KEY },
    body: new URLSearchParams(params).toString(),
  })
}

/** POST /token as application/json — the form-urlencoded path's .toString() calls make it
 *  impossible to send a non-string field, so AC-9 needs this to reach the JSON-body branch. */
async function postTokenJSON(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-brain-key': OPEN_BRAIN_KEY },
    body: JSON.stringify(body),
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OAuth metadata', () => {
  it('AC-1: grant_types_supported includes refresh_token', async () => {
    const res = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`)
    assert.equal(res.status, 200)
    const body = await res.json() as { grant_types_supported: string[] }
    assert.ok(
      body.grant_types_supported.includes('refresh_token'),
      `grant_types_supported=${JSON.stringify(body.grant_types_supported)} missing refresh_token`
    )
  })

  it('AC-1b: token_endpoint_auth_methods_supported no longer advertises none (closes #277)', async () => {
    // As of #277, all three grants (authorization_code and client_credentials via #273,
    // refresh_token via #277) require client_secret_post — 'none' is no longer accurate
    // for any of them, so this now asserts its absence (not just client_secret_post's
    // presence, which #273's own round of review caught was the wrong assertion while
    // refresh_token was still unauthenticated).
    const res = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`)
    const body = await res.json() as { token_endpoint_auth_methods_supported: string[] }
    assert.ok(
      !body.token_endpoint_auth_methods_supported.includes('none'),
      `token_endpoint_auth_methods_supported=${JSON.stringify(body.token_endpoint_auth_methods_supported)} still advertises none`
    )
    assert.ok(
      body.token_endpoint_auth_methods_supported.includes('client_secret_post'),
      `token_endpoint_auth_methods_supported=${JSON.stringify(body.token_endpoint_auth_methods_supported)} missing client_secret_post`
    )
  })
})

describe('authorization_code grant', () => {
  let refreshToken: string
  let accessToken: string

  it('AC-2: token response includes refresh_token', async () => {
    const { code, verifier } = await authorize()
    const res = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    })
    const body = await res.json() as Record<string, unknown>
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
    assert.ok(body.access_token, 'Missing access_token')
    assert.ok(body.refresh_token, 'Missing refresh_token')
    assert.equal(body.token_type, 'Bearer')
    assert.ok(typeof body.expires_in === 'number', 'Missing expires_in')
    refreshToken = body.refresh_token as string
    accessToken = body.access_token as string
  })

  it('AC-7: access_token is a valid JWT with correct sub', async () => {
    assert.ok(accessToken, 'No access_token from previous test')
    const key = new TextEncoder().encode(JWT_SECRET)
    const { payload } = await jwtVerify(accessToken, key)
    assert.equal(payload.sub, CLIENT_ID, `JWT sub mismatch: ${payload.sub}`)
  })

  describe('refresh_token grant', () => {
    let rotatedRefreshToken: string

    it('AC-3: returns new access_token and rotated refresh_token', async () => {
      assert.ok(refreshToken, 'No refresh_token from parent test')
      const res = await postToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
      })
      const body = await res.json() as Record<string, unknown>
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
      assert.ok(body.access_token, 'Missing access_token in refresh response')
      assert.ok(body.refresh_token, 'Missing rotated refresh_token in refresh response')
      assert.equal(body.token_type, 'Bearer')
      assert.notEqual(body.refresh_token, refreshToken, 'Rotated token must differ from the original')
      rotatedRefreshToken = body.refresh_token as string
    })

    it('AC-4: old refresh_token is rejected after rotation', async () => {
      assert.ok(refreshToken, 'No refresh_token from parent test')
      const res = await postToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
      })
      assert.equal(res.status, 400, 'Old token should be invalid after rotation')
      const body = await res.json() as { error: string }
      assert.equal(body.error, 'invalid_grant')
    })

    it('AC-8: replaying used token revokes all remaining tokens (reuse detection)', async () => {
      // The old refreshToken was already consumed in AC-3, then replayed in AC-4.
      // AC-4's replay should have triggered reuse detection and wiped rotatedRefreshToken too.
      assert.ok(rotatedRefreshToken, 'No rotated token from AC-3')
      const res = await postToken({
        grant_type: 'refresh_token',
        refresh_token: rotatedRefreshToken,
        client_id: CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
      })
      assert.equal(res.status, 400, 'Rotated token should have been revoked by reuse detection')
      const body = await res.json() as { error: string }
      assert.equal(body.error, 'invalid_grant')
    })

    it('AC-5: unknown refresh_token → 400 invalid_grant', async () => {
      const res = await postToken({
        grant_type: 'refresh_token',
        refresh_token: 'totally-fake-token-that-does-not-exist',
        client_id: CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
      })
      assert.equal(res.status, 400)
      const body = await res.json() as { error: string }
      assert.equal(body.error, 'invalid_grant')
    })

    it('AC-6: client_id mismatch → 400 invalid_grant', async () => {
      // Get a fresh token for this isolated test
      const { code, verifier } = await authorize()
      const tokenRes = await postToken({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      })
      const { refresh_token: freshToken } = await tokenRes.json() as { refresh_token: string }
      assert.ok(freshToken, 'Could not obtain fresh token for AC-6')

      const res = await postToken({
        grant_type: 'refresh_token',
        refresh_token: freshToken,
        client_id: 'wrong-client-id',
        client_secret: OAUTH_CLIENT_SECRET,
      })
      assert.equal(res.status, 400)
      const body = await res.json() as { error: string }
      assert.equal(body.error, 'invalid_grant')
    })
  })
})

// ── AC-9: a non-string client_secret in a JSON body never crashes /token ──
//
// The form-urlencoded path's `.toString()` calls make every field a string
// by construction, so only a JSON body can carry a non-string value like a
// number. Before client_secret was normalized once at parse time, either
// grant branch below passed it straight into timingSafeEqual's
// crypto.createHash, which throws on a non-string and turns the request
// into a 500 instead of the ordinary 400/401 a malformed request should get.

describe('AC-9: non-string client_secret does not crash /token', () => {
  it('client_credentials grant returns 400, not 500', async () => {
    const res = await postTokenJSON({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: 123,
    })
    assert.notEqual(res.status, 500, 'client_secret: 123 should not crash the request')
    assert.equal(res.status, 400)
    const body = await res.json() as { error: string }
    assert.equal(body.error, 'invalid_request')
  })

  it('authorization_code grant returns 401, not 500', async () => {
    const res = await postTokenJSON({
      grant_type: 'authorization_code',
      code: 'nonexistent-code',
      code_verifier: 'whatever',
      client_id: CLIENT_ID,
      client_secret: 123,
    })
    assert.notEqual(res.status, 500, 'client_secret: 123 should not crash the request')
    // 401 invalid_client, not 400 invalid_grant — the now-required client_secret check
    // (#273's fix) runs before the code lookup ever happens, since client_secret: 123
    // normalizes to undefined and fails that check first.
    assert.equal(res.status, 401)
    const body = await res.json() as { error: string }
    assert.equal(body.error, 'invalid_client')
  })
})

// ── AC-10/AC-11: authorization_code requires the real client_secret (closes #273) ──
//
// /authorize itself is still open to any caller (PKCE protects the code in transit,
// not who can request one) — the fix is that a code is now inert without the secret
// to redeem it. Confirmed live before this fix shipped: a real claude.ai reconnect on
// 2026-09-16 sent client_secret_present: true, client_secret_matches: true, so this
// requirement does not break the live connector — see #275's observability PR.

describe('AC-10/AC-11: authorization_code requires the real client_secret', () => {
  it('AC-10: no client_secret → 401 invalid_client, and the same code is still redeemable with it', async () => {
    const { code, verifier } = await authorize()
    const res = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    })
    assert.equal(res.status, 401)
    const body = await res.json() as { error: string }
    assert.equal(body.error, 'invalid_client')

    // Differential tripwire: re-redeem the SAME code with the real secret. If this
    // fails, the 401 above proved nothing — either the code was already dead (a
    // coincidence, not this check) or the rejected attempt itself consumed it.
    // Succeeding here pins down that the 401 was caused solely by the missing
    // secret, and that a rejected attempt does not consume the code.
    const retryRes = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    })
    assert.equal(retryRes.status, 200, 'The same code should still be redeemable once the real secret is supplied')
  })

  it('AC-11: wrong client_secret → 401 invalid_client, and the same code is still redeemable with the real one', async () => {
    const { code, verifier } = await authorize()
    const res = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      client_secret: `not-${OAUTH_CLIENT_SECRET}`,
      redirect_uri: REDIRECT_URI,
    })
    assert.equal(res.status, 401)
    const body = await res.json() as { error: string }
    assert.equal(body.error, 'invalid_client')

    const retryRes = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    })
    assert.equal(retryRes.status, 200, 'The same code should still be redeemable once the real secret is supplied')
  })
})

/** Obtain a fresh, unused refresh_token via a real authorization_code exchange. */
async function getFreshRefreshToken(): Promise<string> {
  const { code, verifier } = await authorize()
  const res = await postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
  })
  const body = await res.json() as { refresh_token?: string }
  assert.ok(body.refresh_token, `Could not obtain a fresh refresh_token: ${res.status} ${JSON.stringify(body)}`)
  return body.refresh_token
}

// ── AC-12/AC-13/AC-14: refresh_token requires client_secret and client_id (closes #277) ──
//
// Before this fix, the refresh_token grant accepted any possessed refresh token with no
// client authentication at all, and an omitted client_id skipped even the RPC's own
// ownership check (see AC-15 below for that half). Each case here uses a fresh token
// (via getFreshRefreshToken) rather than reusing one from an earlier describe block, so a
// rejected attempt's effect on the token can be verified in isolation.

describe('AC-12/AC-13/AC-14: refresh_token requires client_secret and client_id', () => {
  it('AC-12: no client_secret → 401 invalid_client, and the token is still usable with it', async () => {
    const refreshToken = await getFreshRefreshToken()
    const res = await postToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    })
    assert.equal(res.status, 401)
    const body = await res.json() as { error: string }
    assert.equal(body.error, 'invalid_client')

    // Differential tripwire, same reasoning as AC-10/AC-11: proves the 401 was caused
    // solely by the missing secret, and that a rejected attempt doesn't consume the token.
    const retryRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    })
    assert.equal(retryRes.status, 200, 'The same refresh_token should still work once the real secret is supplied')
  })

  it('AC-13: wrong client_secret → 401 invalid_client, and the token is still usable with the real one', async () => {
    const refreshToken = await getFreshRefreshToken()
    const res = await postToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: `not-${OAUTH_CLIENT_SECRET}`,
    })
    assert.equal(res.status, 401)
    const body = await res.json() as { error: string }
    assert.equal(body.error, 'invalid_client')

    const retryRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    })
    assert.equal(retryRes.status, 200, 'The same refresh_token should still work once the real secret is supplied')
  })

  it('AC-14: no client_id → 400 invalid_request, and the token is still usable with it', async () => {
    const refreshToken = await getFreshRefreshToken()
    const res = await postToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_secret: OAUTH_CLIENT_SECRET,
    })
    assert.equal(res.status, 400)
    const body = await res.json() as { error: string }
    assert.equal(body.error, 'invalid_request')

    const retryRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    })
    assert.equal(retryRes.status, 200, 'The same refresh_token should still work once client_id is supplied')
  })
})

// ── AC-15: rotate_refresh_token's null-p_client_id bypass is closed at the RPC layer ──
//
// The /token handler now always passes a real client_id (AC-14 proves it's mandatory),
// so this path is unreachable through normal HTTP requests — this test calls the RPC
// directly to prove the defense-in-depth fix itself, independent of the application
// layer that happens to make it unreachable today. Before this fix, `p_client_id is not
// null and p_client_id <> v_row.client_id` meant a null p_client_id skipped the ownership
// check entirely and rotated the token for anyone.

describe('AC-15: rotate_refresh_token RPC rejects a null p_client_id', () => {
  it('a direct RPC call with p_client_id: null gets client_mismatch, and the token is untouched', async () => {
    const refreshToken = await getFreshRefreshToken()
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')

    const { data, error } = await supabase.rpc('rotate_refresh_token', {
      p_token_hash: tokenHash,
      p_client_id: null,
      p_new_hash: crypto.randomBytes(32).toString('hex'),
      p_new_expires: new Date(Date.now() + 60_000).toISOString(),
    })
    assert.ok(!error, `RPC call failed: ${error?.message}`)
    assert.equal(
      (data as { status: string }).status,
      'client_mismatch',
      `Expected client_mismatch for a null p_client_id, got ${JSON.stringify(data)}`
    )

    // The RPC's own doc comment promises a client_mismatch leaves the token intact
    // ("token NOT consumed") — confirm that holds by redeeming it normally afterward.
    const retryRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    })
    assert.equal(retryRes.status, 200, 'The token should still be redeemable — a null p_client_id attempt must not consume it')
  })
})
