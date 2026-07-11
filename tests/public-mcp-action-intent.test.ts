/**
 * Unit tests — narrateActionIntentForSurface (src/routes/public-mcp.ts, #195/#183).
 *
 * MCP/API callers have no UI to open the job-fit tool — leaving
 * `action_intent` set would hand them "Opening the job-fit tool now." with
 * nothing to open. This rewrites that response into a narrated pointer at
 * the interactive flow. Pure function — no DB, no network, no live model call.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { narrateActionIntentForSurface } from '../src/routes/public-mcp.js'
import type { QueryResponse } from '../src/types.js'

function baseResponse(actionIntent: { tool: string } | null): QueryResponse {
  return {
    answer: 'Opening the job-fit tool now.',
    confidence: 'high',
    sources: [],
    project_slugs: [],
    follow_up_suggestions: [],
    action_intent: actionIntent,
    contact: { email: 'test@example.com' },
    meta: { model: 'test-model', latency_ms: 12 },
  }
}

describe('narrateActionIntentForSurface', () => {
  it('passes through unchanged when action_intent is already null', () => {
    const response = baseResponse(null)
    const result = narrateActionIntentForSurface(response, 'https://example.com')
    assert.deepEqual(result, response)
  })

  it('nulls action_intent and narrates a pointer with the URL when one is available', () => {
    const response = baseResponse({ tool: 'open_match_tool' })
    const result = narrateActionIntentForSurface(response, 'https://example.dev')
    assert.equal(result.action_intent, null)
    assert.match(result.answer, /https:\/\/example\.dev/)
    assert.match(result.answer, /interactive résumé and job-fit flow/i)
  })

  it('falls back to a generic sentence with no URL when the profile has none', () => {
    const response = baseResponse({ tool: 'open_match_tool' })
    const result = narrateActionIntentForSurface(response, undefined)
    assert.equal(result.action_intent, null)
    assert.ok(!/https?:\/\//.test(result.answer), 'must not fabricate a URL when none is available')
    assert.match(result.answer, /interactive résumé and job-fit flow/i)
  })

  it('never leaves the dead-end "Opening the tool now." acknowledgment in place', () => {
    const response = baseResponse({ tool: 'open_match_tool' })
    const result = narrateActionIntentForSurface(response, 'https://example.dev')
    assert.notEqual(result.answer, 'Opening the job-fit tool now.')
  })

  it('preserves other fields (confidence, contact, meta) unchanged', () => {
    const response = baseResponse({ tool: 'open_match_tool' })
    const result = narrateActionIntentForSurface(response, 'https://example.dev')
    assert.equal(result.confidence, response.confidence)
    assert.deepEqual(result.contact, response.contact)
    assert.deepEqual(result.meta, response.meta)
  })
})
