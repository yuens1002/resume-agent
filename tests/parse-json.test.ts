/**
 * Unit tests — src/lib/parse-json.ts
 *
 * Covers salvageTrailingSourcesBlock (#193/#197 chunk B): a Sources: block
 * emitted by the model AFTER the JSON envelope's closing fence/brace is
 * discarded by parseJSON's greedy {...} extraction, leaving an answer with
 * citation markers and no attribution. This helper reattaches it.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseJSON, salvageTrailingSourcesBlock } from '../src/lib/parse-json.js'

describe('salvageTrailingSourcesBlock', () => {
  it('reattaches a Sources: block the model emitted after the closed fence (captured production shape)', () => {
    const raw = [
      '```json',
      '{',
      '  "answer": "Alex has deep experience with data infrastructure [1] and has shipped several projects [2].",',
      '  "confidence": "high",',
      '  "sources": [],',
      '  "follow_up_suggestions": []',
      '}',
      '```',
      '',
      'Sources:',
      '[1] skills.data_infrastructure',
      '[2] projects',
    ].join('\n')

    const parsed = parseJSON<{ answer: string }>(raw)
    // Sanity: parseJSON itself discards the trailer — this is the bug being salvaged.
    assert.ok(!parsed.answer.includes('Sources:'))

    const salvaged = salvageTrailingSourcesBlock(raw, parsed.answer)
    assert.equal(
      salvaged,
      'Alex has deep experience with data infrastructure [1] and has shipped several projects [2].\n\nSources:\n[1] skills.data_infrastructure\n[2] projects',
    )
  })

  it('pins the worst captured shape: fence-closed JSON + trailer with multiple source lines', () => {
    const raw =
      '```json\n{"answer": "Alex led three initiatives [1][2][3].", "confidence": "high", "sources": [], "follow_up_suggestions": []}\n```\n\nSources:\n[1] projects.alpha\n[2] projects.beta\n[3] projects.gamma\n'
    const parsed = parseJSON<{ answer: string }>(raw)
    const salvaged = salvageTrailingSourcesBlock(raw, parsed.answer)
    assert.equal(
      salvaged,
      'Alex led three initiatives [1][2][3].\n\nSources:\n[1] projects.alpha\n[2] projects.beta\n[3] projects.gamma',
    )
  })

  it('leaves the answer unchanged when it already contains a Sources: block', () => {
    const raw = '{"answer": "Alex shipped it [1].\\n\\nSources:\\n[1] projects"}'
    const parsed = parseJSON<{ answer: string }>(raw)
    assert.equal(salvageTrailingSourcesBlock(raw, parsed.answer), parsed.answer)
  })

  it('leaves a decline answer with no citation markers unchanged', () => {
    const raw = '{"answer": "I don\'t have information about that in Alex\'s profile."}'
    const parsed = parseJSON<{ answer: string }>(raw)
    assert.equal(salvageTrailingSourcesBlock(raw, parsed.answer), parsed.answer)
  })

  it('leaves the answer unchanged when raw has no discarded trailer', () => {
    const raw = '{"answer": "Alex built it [1]."}'
    const parsed = parseJSON<{ answer: string }>(raw)
    assert.equal(salvageTrailingSourcesBlock(raw, parsed.answer), parsed.answer)
  })
})
