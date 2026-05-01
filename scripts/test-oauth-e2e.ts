/**
 * End-to-end OAuth token expiry + rotation test.
 *
 * Required env vars (loaded via --env-file=.env.local):
 *   JWT_SECRET      — to verify the access token locally in step 5
 *
 * Requires the server to be running with ACCESS_TOKEN_TTL ≤ 300 (e.g. 60s):
 *   ACCESS_TOKEN_TTL=60 npm run dev
 *
 * Run:
 *   tsx --env-file=.env.local scripts/test-oauth-e2e.ts
 *
 * What this proves:
 *   1. Initial access_token + refresh_token issued
 *   2. Access token works immediately on the MCP endpoint
 *   3. After expiry, old access token is rejected (401)
 *   4. Refresh token exchanges for a new access_token + rotated refresh_token
 *   5. New access token works on the MCP endpoint
 *   6. Old refresh token is dead (consumed)
 */

import crypto from 'node:crypto'
import { jwtVerify } from 'jose'

const BASE_URL = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
const CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? 'claude-ai-connector'
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'
const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) throw new Error('JWT_SECRET must be set')
const jwtKey = new TextEncoder().encode(JWT_SECRET)

function pass(msg: string) { console.log(`  ✔  ${msg}`) }
function fail(msg: string) { console.error(`  ✖  ${msg}`); process.exitCode = 1 }
function step(n: number, msg: string) { console.log(`\n── Step ${n}: ${msg}`) }
function wait(ms: number) {
  return new Promise<void>(resolve => {
    const end = Date.now() + ms
    const tick = () => {
      const left = Math.ceil((end - Date.now()) / 1000)
      process.stdout.write(`\r     waiting ${left}s...   `)
      if (Date.now() >= end) { process.stdout.write('\n'); resolve() }
      else setTimeout(tick, 500)
    }
    tick()
  })
}

async function authorize() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const url = new URL(`${BASE_URL}/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  const res = await fetch(url.toString(), { redirect: 'manual' })
  if (res.status !== 302) throw new Error(`/authorize returned ${res.status}; expected 302 redirect`)
  const location = res.headers.get('location')
  if (!location) throw new Error('/authorize redirect missing Location header')
  const code = new URL(location).searchParams.get('code')
  if (!code) throw new Error('/authorize redirect missing code query parameter')
  return { code, verifier }
}

async function postToken(params: Record<string, string>) {
  const res = await fetch(`${BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  return { status: res.status, body: await res.json() as Record<string, string | number> }
}

async function mcpPing(accessToken: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  return res.status
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('OAuth end-to-end: token expiry + rotation')
console.log(`Target: ${BASE_URL}`)

step(1, 'Get initial tokens via authorization_code grant')
const { code, verifier } = await authorize()
const { status: s1, body: t1 } = await postToken({
  grant_type: 'authorization_code',
  code, code_verifier: verifier,
  client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
})
if (s1 !== 200 || !t1.access_token || !t1.refresh_token) {
  fail(`Auth code exchange failed: ${s1} ${JSON.stringify(t1)}`); process.exit(1)
}
const originalAccess = t1.access_token as string
const originalRefresh = t1.refresh_token as string
const expiresIn = t1.expires_in as number
pass(`access_token:  ${originalAccess.slice(0, 20)}...  (expires_in=${expiresIn}s)`)
pass(`refresh_token: ${originalRefresh.slice(0, 8)}...`)

step(2, 'Access token works immediately on /mcp')
const status2 = await mcpPing(originalAccess)
status2 === 200 ? pass(`/mcp returned ${status2}`) : fail(`/mcp returned ${status2}, expected 200`)

const MAX_WAIT = 300
if (expiresIn > MAX_WAIT) {
  fail(`expires_in=${expiresIn}s is too long to wait (max ${MAX_WAIT}s). Restart the server with ACCESS_TOKEN_TTL=60.`)
  process.exit(1)
}

step(3, `Wait ${expiresIn + 5}s for access token to expire`)
await wait((expiresIn + 5) * 1000)

step(4, 'Expired access token is now rejected by /mcp')
const status4 = await mcpPing(originalAccess)
status4 === 401 ? pass(`/mcp correctly returned 401 for expired token`) : fail(`/mcp returned ${status4}, expected 401`)

step(5, 'Expired access token also fails local JWT verification')
try {
  await jwtVerify(originalAccess, jwtKey)
  fail('jwtVerify should have thrown for expired token')
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  msg.toLowerCase().includes('expir') || msg.includes('exp') ? pass(`jwtVerify threw: ${msg}`) : fail(`Unexpected error: ${msg}`)
}

step(6, 'Use refresh token to get new access_token + rotated refresh_token')
const { status: s6, body: t6 } = await postToken({
  grant_type: 'refresh_token',
  refresh_token: originalRefresh,
  client_id: CLIENT_ID,
})
if (s6 !== 200 || !t6.access_token || !t6.refresh_token) {
  fail(`Refresh failed: ${s6} ${JSON.stringify(t6)}`); process.exit(1)
}
const newAccess = t6.access_token as string
const newRefresh = t6.refresh_token as string
pass(`new access_token:  ${newAccess.slice(0, 20)}...`)
pass(`new refresh_token: ${newRefresh.slice(0, 8)}...`)
newAccess !== originalAccess ? pass('New access token differs from original') : fail('Access token unchanged')
newRefresh !== originalRefresh ? pass('Refresh token rotated') : fail('Refresh token unchanged — no rotation')

step(7, 'New access token works on /mcp')
const status7 = await mcpPing(newAccess)
status7 === 200 ? pass(`/mcp returned ${status7}`) : fail(`/mcp returned ${status7}, expected 200`)

step(8, 'Old refresh token is dead after rotation')
const { status: s8, body: t8 } = await postToken({
  grant_type: 'refresh_token',
  refresh_token: originalRefresh,
  client_id: CLIENT_ID,
})
s8 === 400 && t8.error === 'invalid_grant'
  ? pass(`Old refresh token rejected: ${t8.error}`)
  : fail(`Expected 400 invalid_grant, got ${s8}: ${JSON.stringify(t8)}`)

console.log('')
process.exitCode === 1 ? console.error('Some checks failed.') : console.log('All checks passed.')
