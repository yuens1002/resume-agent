import '../lib/env.js'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import crypto from 'crypto'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) throw new Error('Missing JWT_SECRET')
const jwtSecretBytes = new TextEncoder().encode(JWT_SECRET)

const ACCESS_TOKEN_TTL = parseInt(process.env.ACCESS_TOKEN_TTL ?? '3600')
const REFRESH_TOKEN_TTL = parseInt(process.env.REFRESH_TOKEN_TTL ?? '2592000')

const inMemoryRefreshTokens = new Map<string, { client_id: string; expires_at: number }>()

// Allowlist of permitted client IDs — set OAUTH_CLIENT_ID env var (comma-separated for multiple)
const ALLOWED_CLIENT_IDS = new Set(
  (process.env.OAUTH_CLIENT_ID ?? 'claude-ai-connector').split(',').map((s) => s.trim()).filter(Boolean)
)

const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET ?? ''

function timingSafeEqual(a: string, b: string): boolean {
  // Compare fixed-length digests to avoid length-based timing differences
  const aDigest = crypto.createHash('sha256').update(a).digest()
  const bDigest = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(aDigest, bDigest)
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
  for (const [token, data] of inMemoryRefreshTokens) {
    if (now > data.expires_at) inMemoryRefreshTokens.delete(token)
  }
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
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
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

  const noCacheHeaders = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const

  if (grant_type === 'client_credentials') {
    if (!client_id || !client_secret) {
      return c.json({ error: 'invalid_request', error_description: 'client_id and client_secret required' }, 400, noCacheHeaders)
    }
    if (!ALLOWED_CLIENT_IDS.has(client_id) || !OAUTH_CLIENT_SECRET || !timingSafeEqual(client_secret, OAUTH_CLIENT_SECRET)) {
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
    if (!refresh_token) {
      return c.json({ error: 'invalid_request', error_description: 'refresh_token required' }, 400, noCacheHeaders)
    }

    const stored = inMemoryRefreshTokens.get(refresh_token)
    if (!stored || Date.now() > stored.expires_at) {
      console.log('[oauth] refresh_token grant: invalid/expired token')
      return c.json({ error: 'invalid_grant' }, 400, noCacheHeaders)
    }

    console.log('[oauth] refresh_token grant success', { client_id: stored.client_id })

    const now = Math.floor(Date.now() / 1000)
    const newAccessToken = await new SignJWT({ sub: stored.client_id })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + ACCESS_TOKEN_TTL)
      .sign(jwtSecretBytes)

    return c.json(
      { access_token: newAccessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL },
      200,
      noCacheHeaders
    )
  }

  if (grant_type !== 'authorization_code') {
    return c.json({ error: 'unsupported_grant_type' }, 400)
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
  inMemoryRefreshTokens.set(refreshToken, {
    client_id,
    expires_at: Date.now() + REFRESH_TOKEN_TTL * 1000,
  })

  console.log('[oauth] authorization_code grant', { client_id, has_refresh: true })

  return c.json(
    { access_token, refresh_token: refreshToken, token_type: 'Bearer', expires_in: expiresIn },
    200,
    { 'Cache-Control': 'no-store', Pragma: 'no-cache' }
  )
})

export default oauth
