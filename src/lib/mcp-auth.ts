/**
 * Owner-credential check for /mcp — shared by routes/mcp.ts's authenticate()
 * and index.ts's global rate-limiter bypass, so the two can't drift apart
 * the way they did before: index.ts recognized only the x-brain-key header
 * (fixed 2026-09-16) and, until this module, still missed the OAuth Client
 * Credentials JWT Bearer token that authenticate() has always accepted (the
 * claude.ai connector path) — see CHANGELOG.md's 2026-09-16 entries.
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
 * valid x-brain-key header, or a valid OAuth 2.0 Client Credentials HS256
 * JWT via `Authorization: Bearer <token>` (issued by /token's
 * client_credentials grant, routes/oauth.ts).
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
      console.log('[mcp] authenticate failure', { error: (err as Error).message })
    }
  }
  return false
}
