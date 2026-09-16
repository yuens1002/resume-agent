import '../lib/env.js'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import crypto from 'crypto'
import { supabase } from '../lib/supabase.js'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) throw new Error('Missing JWT_SECRET')
const jwtSecretBytes = new TextEncoder().encode(JWT_SECRET)

function parsePositiveIntegerEnv(
  name: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const raw = process.env[name]
  const value = raw == null || raw.trim() === '' ? String(defaultValue) : raw.trim()

  if (!/^\d+$/.test(value)) {
    console.warn(`[oauth] ${name}: invalid non-numeric value, using default ${defaultValue}`)
    return defaultValue
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    console.warn(`[oauth] ${name}: value ${parsed} out of bounds ${min}-${max}, using default ${defaultValue}`)
    return defaultValue
  }

  return parsed
}

const ACCESS_TOKEN_TTL = parsePositiveIntegerEnv('ACCESS_TOKEN_TTL', 3600, 1, 7 * 24 * 60 * 60)
const REFRESH_TOKEN_TTL = parsePositiveIntegerEnv('REFRESH_TOKEN_TTL', 2592000, 1, 365 * 24 * 60 * 60)

const DEBUG = process.env.DEBUG === 'true'

// Allowlist of permitted client IDs — set OAUTH_CLIENT_ID env var (comma-separated for multiple)
const ALLOWED_CLIENT_IDS = new Set(
  (process.env.OAUTH_CLIENT_ID ?? 'claude-ai-connector').split(',').map((s) => s.trim()).filter(Boolean)
)

// Load-bearing for all three grants below — client_credentials always required it,
// authorization_code as of #273's fix, refresh_token as of #277's — so this fails
// fast at startup (matching JWT_SECRET above) rather than silently 401ing every
// claude.ai reconnect with no server-side signal if this is ever unset or blank. Only
// the blank-value guard trims — the stored/compared value stays opaque, since trimming
// it would reject a real secret that happens to contain intentional leading/trailing
// whitespace (a client sending the untrimmed value would then never match).
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET ?? ''
if (!OAUTH_CLIENT_SECRET.trim()) throw new Error('Missing OAUTH_CLIENT_SECRET')

function timingSafeEqual(a: string, b: string): boolean {
  // Compare fixed-length digests to avoid length-based timing differences
  const aDigest = crypto.createHash('sha256').update(a).digest()
  const bDigest = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(aDigest, bDigest)
}

// Shared by all three grants below (client_credentials, refresh_token,
// authorization_code) — a single check so the comparison logic can't drift
// between branches the way three independent copies risked. OAUTH_CLIENT_SECRET
// is always set by this point (the startup guard above throws otherwise); the
// redundant-looking check here is what lets TypeScript narrow client_secret to
// `string` for the caller without a separate assertion.
function isValidClientSecret(client_secret: string | undefined): client_secret is string {
  return Boolean(client_secret && OAUTH_CLIENT_SECRET && timingSafeEqual(client_secret, OAUTH_CLIENT_SECRET))
}

const ALLOWED_REDIRECT_URIS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
])

// In-memory auth code store (5-min TTL, one-time use)
// Note: single-instance Railway deployment — in-memory is sufficient. For multi-instance,
// migrate to a shared store (Redis/Supabase table) or use self-contained signed tokens.
const authCodes = new Map<string, {
  code_challenge: string
  redirect_uri: string
  client_id: string
  expires_at: number
}>()

const cleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [code, data] of authCodes) {
    if (now > data.expires_at) authCodes.delete(code)
  }
  // Prune rows older than 7 days — keeps consumed tokens live long enough for replay detection
  supabase.from('oauth_refresh_tokens')
    .delete()
    .lt('expires_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .then(({ error }) => { if (error) console.error('[oauth] cleanup: failed to prune tokens', error.message) })
}, 60_000)
cleanupInterval.unref()

const oauth = new Hono()

oauth.get('/.well-known/oauth-authorization-server', (c) => {
  const base = process.env.PUBLIC_URL ?? 'https://agent.yuens.me'
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    // 'none' removed — client_credentials always required client_secret_post,
    // authorization_code as of #273's fix, and refresh_token as of #277's, so
    // all three grants now require it and it's the only real entry point to
    // this token endpoint.
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  })
})

// RFC 9728 — OAuth 2.0 Protected Resource Metadata
// claude.ai fetches this after receiving a 401 to discover which auth server to use
oauth.get('/.well-known/oauth-protected-resource', (c) => {
  const base = process.env.PUBLIC_URL
    ? new URL(process.env.PUBLIC_URL).origin
    : new URL(c.req.url).origin
  return c.json({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
  })
})

oauth.get('/authorize', (c) => {
  const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } = c.req.query()

  if (response_type !== 'code') {
    return c.json({ error: 'unsupported_response_type' }, 400)
  }
  if (!client_id || !ALLOWED_CLIENT_IDS.has(client_id)) {
    return c.json({ error: 'unauthorized_client', error_description: 'client_id not registered' }, 400)
  }
  if (!redirect_uri || !ALLOWED_REDIRECT_URIS.has(redirect_uri)) {
    return c.json({ error: 'invalid_request', error_description: 'redirect_uri not allowed' }, 400)
  }
  if (!code_challenge || code_challenge_method !== 'S256') {
    return c.json({ error: 'invalid_request', error_description: 'PKCE with S256 required' }, 400)
  }

  const code = crypto.randomBytes(32).toString('hex')
  authCodes.set(code, {
    code_challenge,
    redirect_uri,
    client_id,
    expires_at: Date.now() + 5 * 60_000,
  })

  const callbackUrl = new URL(redirect_uri)
  callbackUrl.searchParams.set('code', code)
  if (state) callbackUrl.searchParams.set('state', state)

  return c.redirect(callbackUrl.toString(), 302)
})

oauth.post('/token', async (c) => {
  const contentType = c.req.header('content-type') ?? ''
  let grant_type: string | undefined
  let code: string | undefined
  let code_verifier: string | undefined
  let client_id: string | undefined
  let client_secret: string | undefined
  let redirect_uri: string | undefined
  let refresh_token: string | undefined

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const body = await c.req.formData()
    grant_type = body.get('grant_type')?.toString()
    code = body.get('code')?.toString()
    code_verifier = body.get('code_verifier')?.toString()
    client_id = body.get('client_id')?.toString()
    client_secret = body.get('client_secret')?.toString()
    redirect_uri = body.get('redirect_uri')?.toString()
    refresh_token = body.get('refresh_token')?.toString()
  } else {
    const body = await c.req.json().catch(() => ({}))
    grant_type = body.grant_type
    code = body.code
    code_verifier = body.code_verifier
    client_id = body.client_id
    client_secret = body.client_secret
    redirect_uri = body.redirect_uri
    refresh_token = body.refresh_token
  }

  // A JSON body's fields are unvalidated `any`, unlike the form-urlencoded
  // path's `.toString()` calls above — client_secret is the one field both
  // grant branches below pass into timingSafeEqual's crypto.createHash,
  // which throws on a non-string. Normalize once here so neither branch
  // needs its own guard.
  if (typeof client_secret !== 'string' || client_secret.length === 0) client_secret = undefined

  const noCacheHeaders = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const

  if (grant_type === 'client_credentials') {
    if (!client_id || !client_secret) {
      return c.json({ error: 'invalid_request', error_description: 'client_id and client_secret required' }, 400, noCacheHeaders)
    }
    if (!ALLOWED_CLIENT_IDS.has(client_id) || !isValidClientSecret(client_secret)) {
      return c.json({ error: 'invalid_client' }, 401, noCacheHeaders)
    }

    const now = Math.floor(Date.now() / 1000)
    const expiresIn = ACCESS_TOKEN_TTL
    const access_token = await new SignJWT({ sub: client_id })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + expiresIn)
      .sign(jwtSecretBytes)

    return c.json(
      { access_token, token_type: 'Bearer', expires_in: expiresIn },
      200,
      noCacheHeaders
    )
  }

  if (grant_type === 'refresh_token') {
    // Closes #277 — this grant used to accept a refresh_token with no client
    // authentication at all, and an omitted client_id skipped even the RPC's
    // own ownership check (fixed at that layer too — see
    // supabase/migrations/20260916000000_refresh_token_client_auth.sql).
    // Same secret-then-presence ordering as the authorization_code check
    // below.
    if (!isValidClientSecret(client_secret)) {
      return c.json({ error: 'invalid_client' }, 401, noCacheHeaders)
    }
    if (!refresh_token || !client_id) {
      return c.json({ error: 'invalid_request', error_description: 'refresh_token and client_id required' }, 400, noCacheHeaders)
    }

    const tokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex')
    const newRefreshToken = crypto.randomBytes(32).toString('hex')
    const newTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex')

    // Single atomic transaction: validates ownership, marks old token consumed, inserts new one.
    // Returns a status so the application can distinguish replay (definite) from unknown (ambiguous).
    const { data: result, error: rpcError } = await supabase.rpc('rotate_refresh_token', {
      p_token_hash: tokenHash,
      p_client_id: client_id,
      p_new_hash: newTokenHash,
      p_new_expires: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString(),
    })

    if (rpcError) {
      console.error('[oauth] refresh_token grant: db error', rpcError.message)
      return c.json({ error: 'server_error' }, 500, noCacheHeaders)
    }

    const { status, client_id: storedClientId } = result as { status: string; client_id?: string }

    if (status === 'replayed') {
      console.warn('[oauth] refresh_token grant: replay detected, all tokens revoked for', storedClientId)
      return c.json({ error: 'invalid_grant' }, 400, noCacheHeaders)
    }
    if (status === 'client_mismatch') {
      console.log('[oauth] refresh_token grant: client_id mismatch')
      return c.json({ error: 'invalid_grant', error_description: 'client_id mismatch' }, 400, noCacheHeaders)
    }
    if (status !== 'rotated') {
      console.log('[oauth] refresh_token grant: invalid/expired token', status)
      return c.json({ error: 'invalid_grant' }, 400, noCacheHeaders)
    }

    if (DEBUG) {
      console.log('[oauth] refresh_token grant success', { client_id: storedClientId })
    }

    const now = Math.floor(Date.now() / 1000)
    const newAccessToken = await new SignJWT({ sub: storedClientId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + ACCESS_TOKEN_TTL)
      .sign(jwtSecretBytes)

    return c.json(
      { access_token: newAccessToken, refresh_token: newRefreshToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL },
      200,
      noCacheHeaders
    )
  }

  if (grant_type !== 'authorization_code') {
    return c.json({ error: 'unsupported_grant_type' }, 400)
  }

  // Closes #273 — this grant used to accept a code from any caller who
  // supplied the public default client_id, no secret required, and mint a
  // full-access token. #275 shipped observability-only logging first rather
  // than assume the live claude.ai connector would tolerate this; a real
  // reconnect on 2026-09-16 confirmed `client_secret_present: true,
  // client_secret_matches: true`, so enforcing it here does not break the
  // live connector. /authorize itself is intentionally left open (PKCE
  // still protects the code in transit) — a code without the secret to
  // redeem it is inert, which is what actually closes the hole.
  if (!isValidClientSecret(client_secret)) {
    return c.json({ error: 'invalid_client' }, 401, noCacheHeaders)
  }

  if (!code || !code_verifier || !client_id) {
    return c.json({ error: 'invalid_request', error_description: 'code, code_verifier, and client_id required' }, 400)
  }

  const stored = authCodes.get(code)
  if (!stored || Date.now() > stored.expires_at || stored.client_id !== client_id) {
    return c.json({ error: 'invalid_grant' }, 400)
  }

  // Verify redirect_uri matches the one used at /authorize (RFC 6749 §4.1.3)
  if (redirect_uri && redirect_uri !== stored.redirect_uri) {
    return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400)
  }

  // Verify PKCE: SHA-256(code_verifier) base64url === code_challenge
  const digest = crypto.createHash('sha256').update(code_verifier).digest('base64url')
  if (digest !== stored.code_challenge) {
    return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
  }

  authCodes.delete(code)

  const now = Math.floor(Date.now() / 1000)
  const expiresIn = ACCESS_TOKEN_TTL

  const access_token = await new SignJWT({ sub: client_id })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(jwtSecretBytes)

  const refreshToken = crypto.randomBytes(32).toString('hex')
  const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
  const { error: rtInsertError } = await supabase.from('oauth_refresh_tokens').insert({
    token_hash: refreshTokenHash,
    client_id,
    expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString(),
  })
  if (rtInsertError) {
    console.error('[oauth] authorization_code grant: failed to persist refresh token', rtInsertError.message)
    return c.json({ error: 'server_error' }, 500, { 'Cache-Control': 'no-store', Pragma: 'no-cache' })
  }

  if (DEBUG) {
    console.log('[oauth] authorization_code grant', { client_id, has_refresh: true })
  }

  return c.json(
    { access_token, refresh_token: refreshToken, token_type: 'Bearer', expires_in: expiresIn },
    200,
    { 'Cache-Control': 'no-store', Pragma: 'no-cache' }
  )
})

export default oauth
