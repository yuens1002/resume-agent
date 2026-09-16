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
 * site-wide owner credential the way x-brain-key is, even though #273
 * (routes/oauth.ts's authorization_code grant minting a token with no
 * client_secret) is now fixed: a verified JWT's own claims don't record
 * which grant produced it, and routes/oauth.ts's refresh_token grant still
 * performs no client authentication at all — a possessed (e.g. leaked)
 * refresh token can mint a fresh access token with no secret check (tracked
 * separately, filed after #273's fix). isBrainKeyRequest stays a global
 * rate-limiter bypass (matching #269's existing scope); the JWT bypass
 * stays scoped to /mcp only (see isMcpPath and index.ts) rather than
 * exempting every route, so a JWT obtained through the weaker of the two
 * remaining paths can't also flood the rest of the app unthrottled.
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

const MCP_JWT_CACHE_KEY = 'mcpJwtVerified'

/**
 * True when the request carries any HS256 JWT `Authorization: Bearer
 * <token>` signed with JWT_SECRET — i.e. any access token /token
 * (routes/oauth.ts) issues, regardless of which grant (client_credentials,
 * refresh_token, or authorization_code) produced it.
 *
 * On /mcp, this runs twice per request — once in index.ts's rate-limiter
 * middleware, once in authenticate() — so the result is cached on the
 * request context (c.set/c.get) to avoid a second jwtVerify call and a
 * duplicated DEBUG log for the same token within the same request. The
 * cache never crosses requests; each gets its own Context.
 */
export async function isMcpJwtRequest(c: Context): Promise<boolean> {
  const cached = c.get(MCP_JWT_CACHE_KEY) as boolean | undefined
  if (cached !== undefined) return cached

  const result = await verifyMcpJwt(c)
  c.set(MCP_JWT_CACHE_KEY, result)
  return result
}

async function verifyMcpJwt(c: Context): Promise<boolean> {
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
