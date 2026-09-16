/**
 * Owner-credential checks for /mcp — shared by routes/mcp.ts's authenticate()
 * and index.ts's global rate-limiter bypass, so the credential checks
 * themselves can't drift apart the way they did before: index.ts originally
 * recognized neither of authenticate()'s two credentials; #269 (2026-09-16)
 * added x-brain-key, and until this module it still missed the OAuth JWT
 * Bearer token — see CHANGELOG.md's 2026-09-16 entries for both. The rate
 * limiter deliberately does NOT give both credentials the same bypass scope
 * — see isMcpJwtRequest's own doc below.
 *
 * The JWT check (isMcpJwtRequest) is deliberately NOT trusted as a
 * site-wide owner credential the way x-brain-key is — routes/oauth.ts's
 * `/authorize` issues an authorization_code (and, via it, refresh tokens)
 * to any caller who supplies the public default client_id and reads the
 * redirect Location header themselves, no secret required; only the
 * client_credentials grant is actually gated by OAUTH_CLIENT_SECRET. A JWT
 * therefore proves less than x-brain-key does. isBrainKeyRequest stays a
 * global rate-limiter bypass (matching #269's existing scope); the JWT
 * bypass is intentionally scoped to /mcp only (see isMcpPath and index.ts)
 * rather than exempting every route — the auth-model gap this scoping
 * exists to contain is filed separately as #273.
 */
import './env.js'
import { jwtVerify } from 'jose'
import type { Context } from 'hono'
import { timingSafeEqual } from './crypto.js'

const OPEN_BRAIN_KEY = process.env.OPEN_BRAIN_KEY
const JWT_SECRET = process.env.JWT_SECRET
const jwtSecretBytes = JWT_SECRET ? new TextEncoder().encode(JWT_SECRET) : null

if (!OPEN_BRAIN_KEY) throw new Error('Missing OPEN_BRAIN_KEY')

/** True when the request carries a valid x-brain-key header. */
export function isBrainKeyRequest(c: Context): boolean {
  const brainKey = c.req.header('x-brain-key')
  return Boolean(brainKey && timingSafeEqual(brainKey, OPEN_BRAIN_KEY!))
}

/**
 * True when the request carries any HS256 JWT `Authorization: Bearer
 * <token>` signed with JWT_SECRET — i.e. any access token /token
 * (routes/oauth.ts) issues, regardless of which grant (client_credentials,
 * refresh_token, or authorization_code) produced it.
 */
export async function isMcpJwtRequest(c: Context): Promise<boolean> {
  const authHeader = c.req.header('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!bearerToken || !jwtSecretBytes) return false

  try {
    const result = await jwtVerify(bearerToken, jwtSecretBytes, { algorithms: ['HS256'] })
    if (process.env.DEBUG === 'true') {
      console.log('[mcp] authenticate success', { sub: result.payload.sub, exp: result.payload.exp })
    }
    return true
  } catch (err) {
    // This runs on every /mcp request's rate-limiter check as well as
    // authenticate() itself, so an unconditional log here would fire twice
    // per rejected request — gate it like the success log above instead of
    // spamming production logs.
    if (process.env.DEBUG === 'true') {
      console.log('[mcp] authenticate failure', { error: (err as Error).message })
    }
    return false
  }
}

/** True when the request carries either of /mcp's two owner credentials. */
export async function isOwnerRequest(c: Context): Promise<boolean> {
  return isBrainKeyRequest(c) || (await isMcpJwtRequest(c))
}

/**
 * True for /mcp itself and any sub-path, exact-match-or-slash-terminated so
 * it can't admit an unrelated route sharing the string prefix (e.g.
 * /mcpx or /public-mcp). Takes a plain path string (not a Context) so it's
 * unit-testable without a live server or a Hono request — see
 * tests/mcp-path-scoping.test.ts.
 */
export function isMcpPath(path: string): boolean {
  return path === '/mcp' || path.startsWith('/mcp/')
}
