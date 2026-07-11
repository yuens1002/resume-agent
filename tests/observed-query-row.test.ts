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
      answer: 'Alex built X [1].',
      confidence: 'high' as const,
      sources: ['projects.resume-agent'],
      follow_up_suggestions: ['What else?'],
      action_intent: null as { tool: string } | null,
      contact: {},
      meta: {
        model: 'anthropic/claude-haiku-4.5',
        latency_ms: 9755,
        retrieval_ms: 1046,
        provider: 'Amazon Bedrock',
        finish_reason: 'stop',
      },
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

  // #189: added after a production incident required manually SSHing into
  // the deployed container to compare OpenRouter provider metadata against
  // local calls. Logging these means a future recurrence is queryable
  // directly instead of requiring that live forensic reconstruction again.
  it('maps meta.provider to provider', () => {
    const row = buildObservedQueryRow(fullInput(), 'hashed')
    assert.equal(row.provider, 'Amazon Bedrock')
  })

  it('maps meta.finish_reason to finish_reason', () => {
    const row = buildObservedQueryRow(fullInput(), 'hashed')
    assert.equal(row.finish_reason, 'stop')
  })

  // #195: the classifier pre-pass routing decision, logged so production
  // traffic accuracy can be monitored over time (the weekly judge sweep).
  it('maps response.action_intent.tool to action_intent', () => {
    const input = fullInput()
    input.response.action_intent = { tool: 'open_match_tool' }
    const row = buildObservedQueryRow(input, 'hashed')
    assert.equal(row.action_intent, 'open_match_tool')
  })

  it('nulls action_intent when the response routed to narrate (action_intent: null)', () => {
    const row = buildObservedQueryRow(fullInput(), 'hashed')
    assert.equal(row.action_intent, null)
  })

  // #199: the three-way route's fit-question dimension, logged so the judge
  // sweep can score narrate vs narrate_fit, not just the tool binary.
  it('maps response.fit_question through, and nulls it when absent (streaming partial payload)', () => {
    const withFlag = fullInput()
    ;(withFlag.response as { fit_question?: boolean }).fit_question = true
    assert.equal(buildObservedQueryRow(withFlag, 'h').fit_question, true)

    const withFalse = fullInput()
    ;(withFalse.response as { fit_question?: boolean }).fit_question = false
    assert.equal(buildObservedQueryRow(withFalse, 'h').fit_question, false)

    const partial = { source: 'mcp' as const, question: 'q', response: { answer: 'text' }, latency_ms: 1 }
    assert.equal(buildObservedQueryRow(partial, null).fit_question, null)
  })

  it('nulls action_intent when absent entirely (streaming partial payload)', () => {
    const input = {
      source: 'mcp' as const,
      question: 'q',
      response: { answer: 'collected stream text' },
      latency_ms: 4200,
    }
    const row = buildObservedQueryRow(input, null)
    assert.equal(row.action_intent, null)
  })

  it('nulls provider and finish_reason when absent from meta (older shape / provider that does not report it)', () => {
    const input = fullInput()
    delete (input.response.meta as { provider?: string }).provider
    delete (input.response.meta as { finish_reason?: string }).finish_reason
    const row = buildObservedQueryRow(input, 'h')
    assert.equal(row.provider, null)
    assert.equal(row.finish_reason, null)
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
