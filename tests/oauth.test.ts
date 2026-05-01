/**
 * OAuth endpoint tests — refresh token flow
 *
 * Validates the full OAuth lifecycle that the Claude connector depends on:
 *   AC-1  Metadata advertises refresh_token in grant_types_supported
 *   AC-2  authorization_code exchange returns a refresh_token
 *   AC-3  refresh_token grant returns a new access_token + rotated refresh_token
 *   AC-4  old refresh_token is rejected after rotation (one-time use)
 *   AC-5  Expired / unknown refresh_token → 400 invalid_grant
 *   AC-6  client_id mismatch on refresh → 400 invalid_grant
 *   AC-7  access_token from refresh is valid JWT with correct sub
 *   AC-8  replaying a used refresh_token revokes all tokens for that client (reuse detection)
 *
 * Requirements (in .env.local):
 *   BASE_URL        — defaults to http://localhost:<PORT>
 *   OAUTH_CLIENT_ID — defaults to claude-ai-connector
 *   JWT_SECRET      — used to verify returned JWTs
 *
 * Run (requires local server with Supabase):
 *   npm run test:oauth
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { config } from 'dotenv'
import { jwtVerify } from 'jose'

config({ path: '.env.local' })

const BASE_URL = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
const CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? 'claude-ai-connector'
// Must match ALLOWED_REDIRECT_URIS in oauth.ts
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in .env.local')

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

  const res = await fetch(url.toString(), { redirect: 'manual' })
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
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
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
      })
      assert.equal(res.status, 400, 'Rotated token should have been revoked by reuse detection')
      const body = await res.json() as { error: string }
      assert.equal(body.error, 'invalid_grant')
    })

    it('AC-5: unknown refresh_token → 400 invalid_grant', async () => {
      const res = await postToken({
        grant_type: 'refresh_token',
        refresh_token: 'totally-fake-token-that-does-not-exist',
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
        redirect_uri: REDIRECT_URI,
      })
      const { refresh_token: freshToken } = await tokenRes.json() as { refresh_token: string }
      assert.ok(freshToken, 'Could not obtain fresh token for AC-6')

      const res = await postToken({
        grant_type: 'refresh_token',
        refresh_token: freshToken,
        client_id: 'wrong-client-id',
      })
      assert.equal(res.status, 400)
      const body = await res.json() as { error: string }
      assert.equal(body.error, 'invalid_grant')
    })
  })
})
