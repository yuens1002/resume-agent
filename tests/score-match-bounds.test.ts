/**
 * Unit tests — qualityScore in src/lib/score-match.ts
 * (docs/plans/match-quality-extraction.md)
 *
 * Migrated from #240's skillsScore-specific suite, not kept alongside it —
 * skillsScore is retired (every category is now scored by this one
 * function; see the plan's Open Item 4). The bounded-by-construction
 * discipline #240 established for skillsScore carries over exactly: overflow
 * cannot push the score past 1.0, and a dropped requirement between
 * extraction and scoring still costs what it should rather than vanishing.
 *
 * `/match` returned fit_score 1.37 in #240 because the numerator counted
 * every skill the model classified while the denominator counted only what
 * it extracted as required, with nothing tying the two lists together.
 * Consumers rank and threshold on a 0..1 value — job-hunt-agent validates
 * its shortlist threshold to 0..1, so an out-of-range score passes every
 * threshold that can be configured. The fix generalizes here: numerator
 * sums credit over what was actually scored; denominator is the max of the
 * weight-sum implied by required vs. scored qualities.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { qualityScore } from '../src/lib/score-match.js'
import type { MatchRequiredQuality, MatchScoredQuality, MatchQualityImportance } from '../src/types.js'

const required = (
  n: number,
  importance: MatchQualityImportance = 'must_have',
): MatchRequiredQuality[] =>
  Array.from({ length: n }, (_, i) => ({ name: `r${i}`, category: 'skill', jd_importance: importance }))

const scored = (
  matched: number,
  partial: number,
  missing: number,
  opts: { importance?: MatchQualityImportance; evidence?: 'verified' | 'claimed' } = {},
): MatchScoredQuality[] => {
  const { importance = 'must_have', evidence = 'verified' } = opts
  return [
    ...Array.from({ length: matched }, (_, i) => ({ name: `m${i}`, category: 'skill' as const, jd_importance: importance, verdict: 'matched' as const, evidence_grade: evidence })),
    ...Array.from({ length: partial }, (_, i) => ({ name: `p${i}`, category: 'skill' as const, jd_importance: importance, verdict: 'partial' as const, evidence_grade: evidence })),
    ...Array.from({ length: missing }, (_, i) => ({ name: `x${i}`, category: 'skill' as const, jd_importance: importance, verdict: 'missing' as const, evidence_grade: 'absent' as const })),
  ]
}

describe('qualityScore — bounds (generalizes #240)', () => {
  it('bounds an overflow shape analogous to #240\'s reported 1.88', () => {
    // 6 matched + 3 partial (all must_have/verified, weight 2 each) against
    // 4 required (must_have): weightSum = max(8, 18) = 18; numerator =
    // 6*2*1.0 + 3*2*0.5 = 15. Same overflow shape #240 fixed, generalized.
    const score = qualityScore(required(4), scored(6, 3, 0))
    assert.ok(score <= 1, `expected <= 1, got ${score}`)
    assert.equal(score, 15 / 18)
  })

  it('stays within 0..1 however far the scored list overflows the required list', () => {
    for (const [m, p, x, req] of [
      [6, 3, 0, 4],
      [20, 0, 0, 1],
      [9, 1, 1, 9],
      [13, 1, 2, 14],
      [0, 0, 0, 5],
    ]) {
      const score = qualityScore(required(req), scored(m, p, x))
      assert.ok(score >= 0 && score <= 1, `m${m}/p${p}/x${x} vs ${req} required gave ${score}`)
    }
  })

  it('charges for a dropped requirement instead of letting it vanish', () => {
    // 9 required (must_have) but only 5 scored as matched — the same
    // scenario #240 fixed for skillsScore: weightSum = max(18, 10) = 18,
    // numerator = 5*2*1.0 = 10, score = 10/18 = 5/9 (identical to #240's
    // original 5/9 result at uniform weight/evidence — see the "reduces
    // to #240 exactly" tests below).
    assert.equal(qualityScore(required(9), scored(5, 0, 0)), 5 / 9)
  })

  it('is unchanged when the two lists agree, which is the common case', () => {
    // Regression guard: max() must be a no-op wherever the model was
    // already self-consistent.
    assert.equal(qualityScore(required(4), scored(2, 1, 1)), 5 / 8)
    assert.equal(qualityScore(required(6), scored(1, 1, 4)), 3 / 12)
  })

  it('does not inflate when the required list is empty but qualities were scored', () => {
    assert.equal(qualityScore(required(0), scored(5, 0, 0)), 1)
  })

  it('yields 0 rather than NaN or Infinity when nothing was classified', () => {
    const score = qualityScore(required(0), scored(0, 0, 0))
    assert.ok(Number.isFinite(score), `expected finite, got ${score}`)
    assert.equal(score, 0)
  })

  it('reduces to #240\'s exact skillsScore results at uniform must_have/verified — proves the generalization is not a silent behavior change', () => {
    // #240's own regression cases, replayed verbatim through qualityScore.
    assert.equal(qualityScore(required(4), scored(6, 3, 0)), 7.5 / 9)
    assert.equal(qualityScore(required(9), scored(5, 0, 0)), 5 / 9)
    assert.equal(qualityScore(required(4), scored(2, 1, 1)), 2.5 / 4)
    assert.equal(qualityScore(required(6), scored(1, 1, 4)), 1.5 / 6)
    assert.equal(qualityScore(required(0), scored(5, 0, 0)), 1)
    assert.equal(qualityScore(required(0), scored(0, 0, 0)), 0)
  })
})

describe('qualityScore — evidence_grade discount (new in this design)', () => {
  it('discounts matched credit when evidence is claimed rather than verified', () => {
    const verifiedScore = qualityScore(required(1), scored(1, 0, 0, { evidence: 'verified' }))
    const claimedScore = qualityScore(required(1), scored(1, 0, 0, { evidence: 'claimed' }))
    assert.equal(verifiedScore, 1.0)
    assert.equal(claimedScore, 0.8)
    assert.ok(claimedScore < verifiedScore, 'claimed evidence must score lower than verified for the same verdict')
  })

  it('discounts partial credit the same way', () => {
    const verifiedScore = qualityScore(required(1), scored(0, 1, 0, { evidence: 'verified' }))
    const claimedScore = qualityScore(required(1), scored(0, 1, 0, { evidence: 'claimed' }))
    assert.equal(verifiedScore, 0.5)
    assert.equal(claimedScore, 0.4)
  })

  it('missing scores 0 regardless of evidence_grade — there is nothing to grade', () => {
    assert.equal(qualityScore(required(1), scored(0, 0, 1)), 0)
  })
})

describe('qualityScore — jd_importance weighting (new in this design)', () => {
  it('a matched must_have outweighs a matched preferred', () => {
    // Symmetric setup: one must_have + one preferred required either way,
    // only which one is satisfied flips.
    const mustHaveWins = qualityScore(
      [...required(1, 'must_have'), ...required(1, 'preferred')],
      [...scored(1, 0, 0, { importance: 'must_have' }), ...scored(0, 0, 1, { importance: 'preferred' })],
    )
    const preferredWins = qualityScore(
      [...required(1, 'must_have'), ...required(1, 'preferred')],
      [...scored(0, 0, 1, { importance: 'must_have' }), ...scored(1, 0, 0, { importance: 'preferred' })],
    )
    assert.equal(mustHaveWins, 2 / 3)
    assert.equal(preferredWins, 1 / 3)
    assert.ok(mustHaveWins > preferredWins, 'satisfying the must_have item should score higher than satisfying only the preferred one')
  })
})
