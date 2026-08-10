/**
 * Unit tests — skillsScore in src/lib/score-match.ts (#240)
 *
 * `/match` returned fit_score 1.37 because the skills sub-score was unbounded
 * above: the numerator counted every skill the model classified, the
 * denominator counted only what it extracted as required, and nothing tied the
 * two lists together. Consumers rank and threshold on a 0..1 value —
 * job-hunt-agent validates its shortlist threshold to 0..1, so an out-of-range
 * score passes every threshold that can be configured.
 *
 * These cases pin the invariant and both directions of the failure it can take.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { skillsScore } from '../src/lib/score-match.js'

const skills = (matched: number, partial: number, missing: number) => ({
  matched: Array.from({ length: matched }, (_, i) => `m${i}`),
  partial: Array.from({ length: partial }, (_, i) => `p${i}`),
  missing: Array.from({ length: missing }, (_, i) => `x${i}`),
})

describe('skillsScore', () => {
  it('bounds the payload reported in #240, which used to score 1.88', () => {
    // 6 matched + 3 partial against 4 extracted requirements: (6 + 1.5) / 4.
    const score = skillsScore(skills(6, 3, 0), 4)
    assert.ok(score <= 1, `expected <= 1, got ${score}`)
    assert.equal(score, 7.5 / 9)
  })

  it('stays within 0..1 however far the buckets overflow the required list', () => {
    for (const [m, p, x, required] of [
      [6, 3, 0, 4],
      [20, 0, 0, 1],
      [9, 1, 1, 9],
      [13, 1, 2, 14],
      [0, 0, 0, 5],
    ]) {
      const score = skillsScore(skills(m, p, x), required)
      assert.ok(score >= 0 && score <= 1, `m${m}/p${p}/x${x} vs ${required} required gave ${score}`)
    }
  })

  it('charges for a dropped requirement instead of letting it vanish', () => {
    // The model extracted 9 requirements but only classified the 5 it could
    // call matched. Scoring against the bucket count alone would read 5/5 =
    // 1.00 — in range, silently perfect. The required list holds the
    // denominator up so the omission costs what it should.
    assert.equal(skillsScore(skills(5, 0, 0), 9), 5 / 9)
  })

  it('is unchanged when the two lists agree, which is the common case', () => {
    // Regression guard: max() must be a no-op wherever the model was already
    // self-consistent, so the fix cannot re-rank scores that were never broken.
    assert.equal(skillsScore(skills(2, 1, 1), 4), 2.5 / 4)
    assert.equal(skillsScore(skills(1, 1, 4), 6), 1.5 / 6)
  })

  it('does not inflate when the required list is empty but skills were classified', () => {
    // The old `|| 1` fallback divided by 1 here, so five matched skills scored
    // 5.0. The denominator now falls back to the classified count.
    assert.equal(skillsScore(skills(5, 0, 0), 0), 1)
  })

  it('yields 0 rather than NaN or Infinity when the model classified nothing', () => {
    const score = skillsScore(skills(0, 0, 0), 0)
    assert.ok(Number.isFinite(score), `expected finite, got ${score}`)
    assert.equal(score, 0)
  })
})
