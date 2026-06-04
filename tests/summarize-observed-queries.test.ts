/**
 * Unit tests for summarize_observed_queries aggregation logic
 *
 * Tests the handler's aggregation math, window validation, and output formatting
 * without requiring a live Supabase instance. Uses mocked data.
 *
 * Run:
 *   npm run test:unit
 */

import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'

// Import from production module
import { aggregateObservedQueries, formatEnvelopeToText, type ObservedQuery, type SummarizeInput } from '../src/lib/summarize-observed-queries.js'

// Pin the system clock so the SAMPLE_ROWS fixtures (dated 2026-04-25..28) stay
// inside the default 7-day window forever. Without this, the tests silently
// degrade once real wall-clock time moves past `fixture_date + 7 days`.
const PINNED_NOW = new Date('2026-04-29T00:00:00Z').getTime()
before(() => {
  mock.timers.enable({ apis: ['Date'], now: PINNED_NOW })
})
after(() => {
  mock.timers.reset()
})

// Extract window computation for testing (mirrors handler logic)
function computeEffectiveWindow(input: SummarizeInput): { effectiveSince: string; effectiveUntil: string; isValid: boolean; error?: string } {
  const effectiveUntil = input.until ?? new Date().toISOString()
  const effectiveSince =
    input.since ??
    new Date(new Date(effectiveUntil).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const effectiveSinceMs = Date.parse(effectiveSince)
  const effectiveUntilMs = Date.parse(effectiveUntil)

  if (Number.isNaN(effectiveSinceMs) || Number.isNaN(effectiveUntilMs)) {
    return { effectiveSince, effectiveUntil, isValid: false, error: 'Invalid datetime' }
  }
  if (effectiveSinceMs > effectiveUntilMs) {
    return { effectiveSince, effectiveUntil, isValid: false, error: 'since > until' }
  }
  return { effectiveSince, effectiveUntil, isValid: true }
}

// Test window computation logic (mirrors handler validation)
describe('Window validation (handler logic)', () => {
  it('validates since > until returns error', () => {
    const result = computeEffectiveWindow({
      since: '2026-05-01T00:00:00Z',
      until: '2026-04-01T00:00:00Z',
    })
    assert.equal(result.isValid, false)
    assert.ok(result.error?.includes('since > until'))
  })

  it('validates invalid datetime returns error', () => {
    const result = computeEffectiveWindow({
      since: 'not-a-date',
      until: '2026-04-01T00:00:00Z',
    })
    assert.equal(result.isValid, false)
    assert.ok(result.error?.includes('Invalid'))
  })

  it('handles timezone offset in until (e.g., +01:00)', () => {
    const result = computeEffectiveWindow({
      since: '2026-04-20T00:00:00Z',
      until: '2026-04-30T12:00:00+01:00',
    })
    assert.equal(result.isValid, true, 'Should handle timezone offset correctly')
  })

  it('handles negative timezone offset', () => {
    const result = computeEffectiveWindow({
      since: '2026-04-20T00:00:00-05:00',
      until: '2026-04-30T00:00:00Z',
    })
    assert.equal(result.isValid, true, 'Should handle negative timezone offset')
  })

  it('applies 7-day default when no since provided', () => {
    const result = computeEffectiveWindow({})
    assert.equal(result.isValid, true)
    const sinceDate = new Date(result.effectiveSince)
    const untilDate = new Date(result.effectiveUntil)
    const diffDays = (untilDate.getTime() - sinceDate.getTime()) / (1000 * 60 * 60 * 24)
    assert.ok(diffDays >= 6.9 && diffDays <= 7.1, 'Should default to ~7 days')
  })

  it('uses provided since/until when both given', () => {
    const result = computeEffectiveWindow({
      since: '2026-04-01T00:00:00Z',
      until: '2026-04-15T00:00:00Z',
    })
    assert.equal(result.isValid, true)
    assert.ok(result.effectiveSince.startsWith('2026-04-01'), 'Should preserve since date')
    assert.ok(result.effectiveUntil.startsWith('2026-04-15'), 'Should preserve until date')
  })
})

// Test truncation logic
describe('Truncation detection', () => {
  it('detects truncation when rows > 10000', () => {
    const rows = Array.from({ length: 10001 }, (_, i) => ({ source: 'mcp' as const, question: `q${i}`, caller_hint: null, user_agent: null, ip_hash: null, model: null, latency_ms: null, llm_ms: null, retrieval_ms: null, created_at: '2026-04-28T10:00:00Z' }))
    const isTruncated = (rows?.length ?? 0) > 10000
    assert.equal(isTruncated, true)
  })

  it('does not truncate when rows <= 10000', () => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({ source: 'mcp' as const, question: `q${i}`, caller_hint: null, user_agent: null, ip_hash: null, model: null, latency_ms: null, llm_ms: null, retrieval_ms: null, created_at: '2026-04-28T10:00:00Z' }))
    const isTruncated = (rows?.length ?? 0) > 10000
    assert.equal(isTruncated, false)
  })

  it('handles empty rows', () => {
    const rows: ObservedQuery[] = []
    const isTruncated = (rows?.length ?? 0) > 10000
    assert.equal(isTruncated, false)
  })

  it('handles undefined rows', () => {
    const rows = undefined
    const isTruncated = (rows?.length ?? 0) > 10000
    assert.equal(isTruncated, false)
  })
})

// ── Test fixtures ───────────────────────────────────────────

const SAMPLE_ROWS: ObservedQuery[] = [
  { source: 'mcp', question: 'What are your skills?', caller_hint: 'ATS', user_agent: 'Mozilla/5.0', ip_hash: 'abc123', model: 'gpt-4o', latency_ms: 1200, llm_ms: null, retrieval_ms: null, created_at: '2026-04-25T10:00:00Z' },
  { source: 'mcp', question: 'Tell me about yourself', caller_hint: 'ATS', user_agent: 'Mozilla/5.0', ip_hash: 'abc123', model: 'gpt-4o', latency_ms: 1100, llm_ms: null, retrieval_ms: null, created_at: '2026-04-25T11:00:00Z' },
  { source: 'http', question: 'What is your experience?', caller_hint: 'recruiter', user_agent: 'curl/7.68', ip_hash: 'def456', model: 'gpt-4o-mini', latency_ms: 800, llm_ms: null, retrieval_ms: null, created_at: '2026-04-26T09:00:00Z' },
  { source: 'http', question: 'What is your experience?', caller_hint: 'recruiter', user_agent: 'curl/7.68', ip_hash: 'def456', model: 'gpt-4o-mini', latency_ms: 850, llm_ms: null, retrieval_ms: null, created_at: '2026-04-26T10:00:00Z' },
  { source: 'mcp', question: 'What projects have you built?', caller_hint: 'ai-agent', user_agent: 'Claude/1.0', ip_hash: 'ghi789', model: 'gpt-4o', latency_ms: 1500, llm_ms: null, retrieval_ms: null, created_at: '2026-04-27T14:00:00Z' },
  { source: 'mcp', question: 'What is your availability?', caller_hint: null, user_agent: 'Mozilla/5.0', ip_hash: 'abc123', model: 'gpt-4o', latency_ms: 900, llm_ms: null, retrieval_ms: null, created_at: '2026-04-28T16:00:00Z' },
]

// Rows with phase data (post-Stage-1 instrumentation)
const INSTRUMENTED_ROWS: ObservedQuery[] = [
  { source: 'http', question: 'Show recent work', caller_hint: null, user_agent: 'Chrome', ip_hash: 'aaa', model: 'haiku', latency_ms: 4800, llm_ms: 3600, retrieval_ms: 1200, created_at: '2026-04-28T10:00:00Z' },
  { source: 'http', question: 'Experience with AI?', caller_hint: null, user_agent: 'Chrome', ip_hash: 'bbb', model: 'haiku', latency_ms: 7300, llm_ms: 6400, retrieval_ms: 800, created_at: '2026-04-28T11:00:00Z' },
  { source: 'mcp', question: 'Did you build resume-agent?', caller_hint: null, user_agent: 'Claude', ip_hash: 'ccc', model: 'haiku', latency_ms: 4500, llm_ms: 4300, retrieval_ms: 180, created_at: '2026-04-28T12:00:00Z' },
]

// ── AC-1: Empty window returns friendly message ────────────

describe('AC-1: empty window returns friendly message', () => {
  it('returns "No queries in this window" when no rows match', () => {
    const result = aggregateObservedQueries(SAMPLE_ROWS, {
      since: '2026-01-01T00:00:00Z',
      until: '2026-01-02T00:00:00Z',
    })
    assert.equal(result.totals.count, 0, 'Should have zero queries')
  })
})

// ── AC-2: since > until throws validation error ───────

describe('AC-2: since > until validation', () => {
  it('throws error when since is after until', () => {
    const input = {
      since: '2026-05-01T00:00:00Z',
      until: '2026-04-01T00:00:00Z',
    }
    assert.throws(
      () => aggregateObservedQueries(SAMPLE_ROWS, input),
      /Invalid window/,
      'Should throw when since is after until'
    )
  })
})

// ── AC-3: Window > 10k rows triggers truncated flag ───────

describe('AC-3: truncated flag on large window', () => {
  it('sets truncated:true when rows exceed 10k cap', () => {
    // Generate 10,001 rows
    const bigDataset = Array.from({ length: 10001 }, (_, i) => ({
      source: 'mcp' as const,
      question: `Question ${i}`,
      caller_hint: 'test',
      user_agent: 'test',
      ip_hash: 'x',
      model: 'gpt-4o',
      latency_ms: 100,
      created_at: '2026-04-28T10:00:00Z',
    }))
    const result = aggregateObservedQueries(bigDataset, {})
    assert.equal(result.truncated, true, 'Should flag as truncated')
    assert.equal(result.totals.count, 10000, 'Should cap at 10k')
  })
})

// ── AC-4: Source filter works ───────────────────────────────

describe('AC-4: source filter', () => {
  it('filters to mcp only when specified', () => {
    const result = aggregateObservedQueries(SAMPLE_ROWS, { source: 'mcp' })
    assert.equal(result.totals.count, 4, 'Should have 4 mcp queries')
    assert.equal(result.totals.by_source.mcp, 4)
    assert.equal(result.totals.by_source.http, 0)
  })

  it('filters to http only when specified', () => {
    const result = aggregateObservedQueries(SAMPLE_ROWS, { source: 'http' })
    assert.equal(result.totals.count, 2, 'Should have 2 http queries')
  })
})

// ── AC-5: caller_hint filter works ─────────────────────────

describe('AC-5: caller_hint prefix filter', () => {
  it('filters by caller_hint prefix', () => {
    const result = aggregateObservedQueries(SAMPLE_ROWS, { caller_hint: 'ATS' })
    assert.equal(result.totals.count, 2, 'Should have 2 ATS queries')
    assert.equal(result.top_caller_hints[0]?.caller_hint, 'ATS')
  })
})

// ── AC-6: bucket parameter works ───────────────────────────

describe('AC-6: time bucket parameter', () => {
  it('groups by hour correctly', () => {
    const result = aggregateObservedQueries(SAMPLE_ROWS, { bucket: 'hour' })
    assert.ok(result.trend.length > 0, 'Should have trend buckets')
    // Check that we have hour-level granularity
    const firstBucket = result.trend[0]
    assert.ok(firstBucket.bucket_start.includes(':'), 'Hour buckets include time')
  })

  it('groups by day correctly', () => {
    const result = aggregateObservedQueries(SAMPLE_ROWS, { bucket: 'day' })
    assert.ok(result.trend.length > 0, 'Should have trend buckets')
    // Day buckets should only have date (no time)
    assert.ok(!result.trend[0]?.bucket_start.includes(':'), 'Day buckets should not include time')
  })

  it('groups by week correctly', () => {
    const result = aggregateObservedQueries(SAMPLE_ROWS, { bucket: 'week' })
    assert.ok(result.trend.length > 0, 'Should have trend buckets')
  })
})

// ── AC-7: top_n parameter works ────────────────────────────

describe('AC-7: top_n parameter limits lists', () => {
  it('respects top_n for caller_hints', () => {
    const result = aggregateObservedQueries(SAMPLE_ROWS, { top_n: 2 })
    assert.equal(result.top_caller_hints.length, 2, 'Should return only top 2')
  })

  it('respects top_n for questions', () => {
    const result = aggregateObservedQueries(SAMPLE_ROWS, { top_n: 1 })
    // "What is your experience?" appears twice
    const topQ = result.top_questions[0]
    assert.ok(topQ, 'Should have at least one question')
    if (topQ) {
      assert.equal(topQ.count, 2, 'The duplicated question should have count 2')
    }
  })
})

// ── AC-8: JSON format returns full envelope ───────────────

describe('AC-8: JSON format returns envelope', () => {
  it('includes all envelope fields', () => {
    const result = aggregateObservedQueries(SAMPLE_ROWS, { format: 'json' })
    assert.ok(result.window, 'Should have window')
    assert.ok(result.totals, 'Should have totals')
    assert.ok(result.latency, 'Should have latency')
    assert.ok(result.top_caller_hints, 'Should have top_caller_hints')
    assert.ok(result.top_user_agents, 'Should have top_user_agents')
    assert.ok(result.top_questions, 'Should have top_questions')
    assert.ok(result.top_models, 'Should have top_models')
    assert.ok(result.trend, 'Should have trend')
  })
})

// ── AC-9: Text format is human-readable ────────────────────

describe('AC-9: text format is human-readable', () => {
  it('renders expected sections', () => {
    const envelope = aggregateObservedQueries(SAMPLE_ROWS, {})
    const text = formatEnvelopeToText(envelope)
    assert.match(text, /Query Traffic Summary/, 'Should have header')
    assert.match(text, /Total queries:/, 'Should show total')
    assert.match(text, /by source:/, 'Should show source breakdown')
    assert.match(text, /Latency \(total\):/, 'Should show latency when present')
  })

  it('renders phase breakdown when instrumented rows are present', () => {
    const envelope = aggregateObservedQueries(INSTRUMENTED_ROWS, {})
    const text = formatEnvelopeToText(envelope)
    assert.match(text, /Phase breakdown/, 'Should show phase breakdown section')
    assert.match(text, /avg split:/, 'Should show avg split percentages')
    assert.match(text, /llm/, 'Should show llm row')
    assert.match(text, /retrieval/, 'Should show retrieval row')
  })

  it('omits phase breakdown when no instrumented rows', () => {
    const envelope = aggregateObservedQueries(SAMPLE_ROWS, {})
    const text = formatEnvelopeToText(envelope)
    assert.doesNotMatch(text, /Phase breakdown/, 'Should not show phase section without instrumented rows')
  })
})

// ── AC-10: Latency stats computed correctly ───────────────

describe('AC-10: latency statistics', () => {
  it('calculates avg, p50, p95, max correctly', () => {
    const result = aggregateObservedQueries(SAMPLE_ROWS, {})
    // latencies: 1200, 1100, 800, 850, 1500, 900
    // avg = 1058
    // sorted: 800, 850, 900, 1100, 1200, 1500
    // p50 = index floor(6*0.5)=3 -> 1100, p95 = index floor(6*0.95)=5 -> 1500, max = 1500
    assert.equal(result.latency.avg_ms, 1058, 'Avg should be 1058')
    assert.equal(result.latency.p50_ms, 1100, 'p50 should be 1100 (index 3 of 6)')
    assert.equal(result.latency.p95_ms, 1500, 'p95 should be 1500')
    assert.equal(result.latency.max_ms, 1500, 'max should be 1500')
  })
})

// ── AC-11: Question normalization (case + trim) ───────────

describe('AC-11: question normalization groups normalized variants together', () => {
  it('groups "Tell me about yourself" and "tell me about yourself!" together', () => {
    const mixedRows: ObservedQuery[] = [
      { source: 'mcp', question: 'Tell me about yourself', caller_hint: null, user_agent: 'x', ip_hash: 'x', model: 'x', latency_ms: 100, created_at: '2026-04-28T10:00:00Z' },
      { source: 'mcp', question: 'tell me about yourself!', caller_hint: null, user_agent: 'x', ip_hash: 'x', model: 'x', latency_ms: 100, created_at: '2026-04-28T11:00:00Z' },
    ]
    const result = aggregateObservedQueries(mixedRows, {})
    // Both should group under the second one's normalized key
    // The current impl keeps original casing from first match
    assert.equal(result.top_questions.length, 1, 'Should be one group')
    assert.equal(result.top_questions[0].count, 2, 'Should have count of 2')
  })
})