/**
 * Shared helpers for MCP routes (private `/mcp` and public `/public-mcp`).
 *
 * Exported surface:
 *   - ALLOWED_ORIGINS  — configurable browser-origin allowlist
 *   - corsHeaders      — response CORS block applied to every MCP response
 *   - checkOrigin(c)   — returns a 403 Response if the Origin header is
 *                        present and not on the allowlist; null otherwise
 *
 * Auth logic (authenticate/unauthorized) stays in src/routes/mcp.ts because
 * it is specific to the private tool surface.
 */

import type { Context } from 'hono'

// Allowed browser origins — prevents DNS rebinding attacks (MCP Streamable HTTP spec MUST).
// Non-browser clients (curl, Claude Desktop) send no Origin header and are always allowed.
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  'https://claude.ai',
  ...(process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
])

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-brain-key, accept, mcp-session-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
} as const

export function checkOrigin(c: Context): Response | null {
  const origin = c.req.header('origin')
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
  return null
}
