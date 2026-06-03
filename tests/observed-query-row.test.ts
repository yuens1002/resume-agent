/**
 * Unit tests — buildObservedQueryRow (log-observed-query.ts)
 *
 * Verifies the column mapping, especially the phase-timing fields
 * (`llm_ms`, `retrieval_ms`) added in the query-latency instrumentation.
 * Pure function — no DB, no network.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildObservedQueryRow } from '../src/lib/log-observed-query.js'

function fullInput() {
  return {
    source: 'http' as const,
    question: 'What are your recent projects?',
    caller_hint: 'Recruiter reviewing candidates.',
    response: {
      answer: 'Sunny built X [1].',
      confidence: 'high' as const,
      sources: ['projects.resume-agent'],
      follow_up_suggestions: ['What else?'],
      contact: {},
      meta: { model: 'anthropic/claude-haiku-4.5', latency_ms: 9755, retrieval_ms: 1046 },
    },
    latency_ms: 10801,
    ip: '203.0.113.5',
    user_agent: 'test-agent',
  }
}

describe('buildObservedQueryRow', () => {
  it('maps wall-clock total to latency_ms', () => {
    const row = buildObservedQueryRow(fullInput(), 'hashed')
    assert.equal(row.latency_ms, 10801)
  })

  it('maps LLM time from meta.latency_ms to llm_ms', () => {
    const row = buildObservedQueryRow(fullInput(), 'hashed')
    assert.equal(row.llm_ms, 9755)
  })

  it('maps meta.retrieval_ms to retrieval_ms', () => {
    const row = buildObservedQueryRow(fullInput(), 'hashed')
    assert.equal(row.retrieval_ms, 1046)
  })

  it('passes the supplied ip_hash through verbatim (never the raw ip)', () => {
    const row = buildObservedQueryRow(fullInput(), 'deadbeef')
    assert.equal(row.ip_hash, 'deadbeef')
    assert.ok(!JSON.stringify(row).includes('203.0.113.5'), 'raw IP must never appear in the row')
  })

  it('nulls llm_ms and retrieval_ms when meta is absent (streaming partial payload)', () => {
    const input = {
      source: 'mcp' as const,
      question: 'q',
      response: { answer: 'collected stream text' },
      latency_ms: 4200,
    }
    const row = buildObservedQueryRow(input, null)
    assert.equal(row.llm_ms, null)
    assert.equal(row.retrieval_ms, null)
    assert.equal(row.latency_ms, 4200)
    assert.equal(row.ip_hash, null)
  })

  it('nulls retrieval_ms when meta has llm timing but no retrieval (older shape)', () => {
    const input = fullInput()
    delete (input.response.meta as { retrieval_ms?: number }).retrieval_ms
    const row = buildObservedQueryRow(input, 'h')
    assert.equal(row.llm_ms, 9755)
    assert.equal(row.retrieval_ms, null)
  })
})
