/**
 * Owner-credential check for /mcp — shared by routes/mcp.ts's authenticate()
 * and index.ts's global rate-limiter bypass, so the two can't drift apart
 * the way they did before: index.ts originally recognized neither of
 * authenticate()'s two credentials; #269 (2026-09-16) added x-brain-key, and
 * until this module it still missed the OAuth JWT Bearer token — see
 * CHANGELOG.md's 2026-09-16 entries for both.
 */
import './env.js'
import { jwtVerify } from 'jose'
import type { Context } from 'hono'
import { timingSafeEqual } from './crypto.js'

const OPEN_BRAIN_KEY = process.env.OPEN_BRAIN_KEY
const JWT_SECRET = process.env.JWT_SECRET
const jwtSecretBytes = JWT_SECRET ? new TextEncoder().encode(JWT_SECRET) : null

if (!OPEN_BRAIN_KEY) throw new Error('Missing OPEN_BRAIN_KEY')

/**
 * True when the request carries either of /mcp's two owner credentials: a
 * valid x-brain-key header, or any HS256 JWT `Authorization: Bearer <token>`
 * signed with JWT_SECRET — i.e. any access token /token (routes/oauth.ts)
 * issues, regardless of which grant (client_credentials, refresh_token, or
 * authorization_code) produced it.
 */
export async function isOwnerRequest(c: Context): Promise<boolean> {
  const brainKey = c.req.header('x-brain-key')
  if (brainKey && timingSafeEqual(brainKey, OPEN_BRAIN_KEY!)) return true

  const authHeader = c.req.header('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (bearerToken && jwtSecretBytes) {
    try {
      const result = await jwtVerify(bearerToken, jwtSecretBytes, { algorithms: ['HS256'] })
      if (process.env.DEBUG === 'true') {
        console.log('[mcp] authenticate success', { sub: result.payload.sub, exp: result.payload.exp })
      }
      return true
    } catch (err) {
      // This now runs on every route's rate-limiter check, not just /mcp
      // (see index.ts), so an unconditional log here would fire for any
      // request anywhere that happens to carry a bad Bearer value — gate it
      // like the success log above instead of spamming production logs.
      if (process.env.DEBUG === 'true') {
        console.log('[mcp] authenticate failure', { error: (err as Error).message })
      }
    }
  }
  return false
}
