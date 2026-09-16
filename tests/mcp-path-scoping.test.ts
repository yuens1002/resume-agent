/**
 * isMcpPath (src/lib/mcp-auth.ts) — offline, no live server required.
 *
 * Proves the predicate index.ts's rate-limiter uses to scope the OAuth JWT
 * bypass to /mcp matches exactly what Hono actually routes to mcpRoute
 * (app.route('/mcp', mcpRoute); mcpRoute.post('*') / .options('*')), and
 * rejects everything else — including the exact "startsWith admits an
 * unrelated sibling" shape flagged by this repo's own retro-sourced rule set
 * (a prefix bypass must be delimiter-terminated).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isMcpPath } from '../src/lib/mcp-auth.js'

describe('isMcpPath', () => {
  it('matches /mcp itself', () => {
    assert.ok(isMcpPath('/mcp'))
  })

  it('matches /mcp/ and any /mcp/<sub-path>', () => {
    assert.ok(isMcpPath('/mcp/'))
    assert.ok(isMcpPath('/mcp/x'))
    assert.ok(isMcpPath('/mcp/anything/nested'))
  })

  it('rejects a sibling route sharing the string prefix', () => {
    assert.equal(isMcpPath('/mcpx'), false)
    assert.equal(isMcpPath('/mcp-extra'), false)
    assert.equal(isMcpPath('/public-mcp'), false)
  })

  it('rejects unrelated and malformed paths', () => {
    assert.equal(isMcpPath('/MCP'), false)
    assert.equal(isMcpPath('//mcp'), false)
    assert.equal(isMcpPath(''), false)
    assert.equal(isMcpPath('/'), false)
    assert.equal(isMcpPath('/info'), false)
  })
})
