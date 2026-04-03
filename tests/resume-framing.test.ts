/**
 * Unit tests — /resume framing_hints
 *
 * Tests Zod schema validation and prompt injection logic entirely in-process.
 * No network, no env vars, no Supabase.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

// ── Schema (mirrors src/routes/resume.ts) ─────────────────

const schema = z.object({
  job_description: z.string().min(1),
  framing_hints: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
})

// ── Prompt builder (mirrors src/routes/resume.ts) ─────────

function buildUserMessage(jd: string, hints?: string[]): string {
  let msg = `Target job description:\n${jd}`
  if (hints?.length) {
    msg += `\n\nFraming guidance:\n${hints.map((h) => `- ${h.replace(/\n+/g, ' ')}`).join('\n')}`
  }
  return msg
}

// ── Schema validation tests ───────────────────────────────

describe('framing_hints schema validation', () => {
  it('passes when framing_hints is omitted', () => {
    const result = schema.parse({ job_description: 'Software engineer role' })
    assert.equal(result.framing_hints, undefined)
  })

  it('passes with empty array', () => {
    const result = schema.parse({ job_description: 'some JD', framing_hints: [] })
    assert.deepEqual(result.framing_hints, [])
  })

  it('passes with valid hints', () => {
    const result = schema.parse({
      job_description: 'some JD',
      framing_hints: ['Emphasize backend experience', 'Downplay management gaps'],
    })
    assert.deepEqual(result.framing_hints, ['Emphasize backend experience', 'Downplay management gaps'])
  })

  it('trims leading/trailing whitespace from each hint', () => {
    const result = schema.parse({ job_description: 'some JD', framing_hints: ['  trimmed  '] })
    assert.deepEqual(result.framing_hints, ['trimmed'])
  })

  it('rejects whitespace-only strings (min(1) after trim)', () => {
    assert.throws(
      () => schema.parse({ job_description: 'some JD', framing_hints: ['   '] }),
      { message: /String must contain at least 1 character/ }
    )
  })

  it('rejects hints over 200 characters', () => {
    assert.throws(
      () => schema.parse({ job_description: 'some JD', framing_hints: ['x'.repeat(201)] }),
      { message: /String must contain at most 200 character/ }
    )
  })

  it('accepts a hint of exactly 200 characters', () => {
    assert.doesNotThrow(() =>
      schema.parse({ job_description: 'some JD', framing_hints: ['x'.repeat(200)] })
    )
  })

  it('rejects more than 10 hints', () => {
    assert.throws(
      () => schema.parse({ job_description: 'some JD', framing_hints: Array(11).fill('hint') }),
      { message: /Array must contain at most 10 element/ }
    )
  })

  it('accepts exactly 10 hints', () => {
    assert.doesNotThrow(() =>
      schema.parse({ job_description: 'some JD', framing_hints: Array(10).fill('hint') })
    )
  })

  it('rejects missing job_description', () => {
    assert.throws(() => schema.parse({ framing_hints: ['hint'] }))
  })

  it('rejects empty job_description', () => {
    assert.throws(() => schema.parse({ job_description: '', framing_hints: ['hint'] }))
  })
})

// ── Prompt injection tests ────────────────────────────────

describe('framing_hints prompt injection', () => {
  it('no hints → no framing block in prompt', () => {
    const msg = buildUserMessage('some JD')
    assert.ok(!msg.includes('Framing guidance'), 'Should not add framing block when hints is undefined')
  })

  it('empty array → no framing block in prompt', () => {
    const msg = buildUserMessage('some JD', [])
    assert.ok(!msg.includes('Framing guidance'), 'Should not add framing block when hints is empty')
  })

  it('single hint → framing block appended', () => {
    const msg = buildUserMessage('some JD', ['Focus on backend'])
    assert.ok(msg.includes('Framing guidance:'), 'Should include framing header')
    assert.ok(msg.includes('- Focus on backend'), 'Should include hint as bullet')
  })

  it('multiple hints → each on its own bullet line', () => {
    const msg = buildUserMessage('some JD', ['hint one', 'hint two', 'hint three'])
    assert.ok(msg.includes('- hint one\n- hint two\n- hint three'))
  })

  it('hint with internal newlines → newlines replaced with space', () => {
    const msg = buildUserMessage('some JD', ['line one\nline two'])
    assert.ok(msg.includes('- line one line two'), 'Newline should be replaced with space')
    assert.ok(!msg.includes('line one\nline two'), 'Original newline should not survive')
  })

  it('hint with multiple consecutive newlines → collapsed to single space', () => {
    const msg = buildUserMessage('some JD', ['line one\n\n\nline two'])
    assert.ok(msg.includes('- line one line two'))
  })

  it('framing block appears after job description', () => {
    const msg = buildUserMessage('my JD text', ['a hint'])
    const jdPos = msg.indexOf('my JD text')
    const framingPos = msg.indexOf('Framing guidance:')
    assert.ok(jdPos < framingPos, 'Framing block should come after job description')
  })
})
