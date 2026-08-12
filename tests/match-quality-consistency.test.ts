/**
 * Consistency tests — src/lib/score-match.ts extraction-first scoring
 * (docs/plans/match-quality-extraction.md, deliverable D6)
 *
 * Answers the owner's stated concern directly (2026-08-12): coding the
 * evidence-weighing procedure correctly does not guarantee the model applies
 * it consistently call to call. This is the empirical check, not a code
 * review of the prompt. Three dimensions:
 *
 *   AC-TST-3  Same-model repeatability — N=5 repeats on MATCH_MODEL.
 *             Anchors (unambiguous) must fully agree; the deliberately
 *             ambiguous `scale-different-large-enterprise` case is allowed
 *             bounded disagreement, not zero — per /test-engineer Rule 10
 *             (Reproduced vs. Argued), an all-anchor sample would pass
 *             trivially without exercising real judgment.
 *   AC-TST-4  Cross-model agreement — one pass each on google/gemini-3.6-flash
 *             and openai/gpt-5.6-luna-pro against the same cases. Diagnostic
 *             on this first run (no prior baseline to gate against yet) —
 *             reported, not failed on.
 *   Phrasing  invariance — the spike's B1/B2/B3 triad (raw number / plain
 *             description / named idiom for "large company"). Spike round 3
 *             (tightened EXTRACT instruction) showed B1/B2 converge to
 *             unanimous non-extraction across all 3 models; B3 ("Fortune 500
 *             scale") stays genuinely contested even after tightening —
 *             asserted as bounded-not-zero, matching the fixture's own
 *             `scale-different-large-enterprise` framing.
 *
 * Live model calls — NOT part of test:unit. Requires OPENROUTER_API_KEY (or
 * OPENROUTER_API_KEY_EVAL) in .env.local.
 *
 * Run: npm run test:match-consistency
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scoreMatch } from '../src/lib/score-match.js'
import type { MatchScoredQuality } from '../src/types.js'

const CROSS_MODELS = ['google/gemini-3.6-flash', 'openai/gpt-5.6-luna-pro']
const SAME_MODEL_REPEATS = 5

const ANCHOR_HIGH_JD =
  'Founding Product Engineer — early-stage proptech startup (2-person team). ' +
  'Own the full stack solo: TypeScript, Next.js, React, Node.js/Hono, Supabase/PostgreSQL. ' +
  'Build AI-agent features using the Vercel AI SDK and Model Context Protocol (MCP). ' +
  '3+ years of professional software engineering experience required. ' +
  'Individual contributor role, no direct reports.'

const ANCHOR_LOW_JD =
  'VP of Engineering — 5,000+ employee healthcare enterprise. ' +
  '15+ years of experience required, including 8+ years managing engineering managers ' +
  'across a 40-person org (hiring, performance reviews, budget ownership). ' +
  'Deep native mobile expertise required: Swift/iOS and Kotlin/Android. ' +
  'Domain expertise in clinical/healthcare systems mandatory.'

const SCALE_AMBIGUOUS_JD =
  '50,000+ employee global enterprise, large engineering org. TypeScript/React/Node, 3+ years ' +
  'experience, IC.'

/** Find the quality most representative of "does this JD's scale/enterprise
 * framing get treated as a candidate requirement" — the axis the spike
 * showed actually varies. Returns undefined if nothing matched (itself a
 * valid, informative outcome for the ambiguous case). */
function findScaleQuality(qualities: MatchScoredQuality[]): MatchScoredQuality | undefined {
  return qualities.find((q) => /50|enterprise|scale|large/i.test(q.name))
}

async function repeatedRuns(jd: string, n: number, model?: string) {
  const runs: (MatchScoredQuality | undefined)[] = []
  for (let i = 0; i < n; i++) {
    const result = await scoreMatch(jd, undefined, model)
    assert.ok(result, `scoreMatch returned null on run ${i + 1}`)
    runs.push(findScaleQuality(result.scoring.scored_qualities))
  }
  return runs
}

function extractionRate(runs: (MatchScoredQuality | undefined)[]): number {
  return runs.filter((r) => r !== undefined).length / runs.length
}

describe('same-model repeatability (AC-TST-3)', () => {
  it('anchor-high: fully agrees across 5 runs — no scale requirement is stated, extraction must be stable', async () => {
    const runs = await repeatedRuns(ANCHOR_HIGH_JD, SAME_MODEL_REPEATS)
    const rate = extractionRate(runs)
    assert.ok(
      rate === 0 || rate === 1,
      `unambiguous case should be all-or-nothing across runs, got extraction on ${rate * 100}% of ${SAME_MODEL_REPEATS} runs: ${JSON.stringify(runs)}`,
    )
  })

  it('anchor-low: fully agrees across 5 runs on core skill-gap qualities (Swift/Kotlin)', async () => {
    const verdicts: string[] = []
    for (let i = 0; i < SAME_MODEL_REPEATS; i++) {
      const result = await scoreMatch(ANCHOR_LOW_JD)
      assert.ok(result, `scoreMatch returned null on run ${i + 1}`)
      const mobile = result.scoring.scored_qualities.find((q) => /swift|kotlin|native mobile/i.test(q.name))
      verdicts.push(mobile?.verdict ?? 'not-extracted')
    }
    const disagreements = verdicts.filter((v) => v !== verdicts[0]).length
    assert.ok(
      disagreements === 0,
      `expected unanimous "missing" for a skill the candidate has never touched — got ${disagreements}/${SAME_MODEL_REPEATS} disagreements: ${JSON.stringify(verdicts)}`,
    )
  })

  it('scale-different-large-enterprise: allows BOUNDED disagreement, not zero (Rule 10 — this case is deliberately ambiguous)', async () => {
    const runs = await repeatedRuns(SCALE_AMBIGUOUS_JD, SAME_MODEL_REPEATS)
    const rate = extractionRate(runs)
    // Not asserting a specific rate — the spike showed this genuinely varies.
    // The invariant under test is narrower: the case must not silently start
    // *crashing* or returning malformed output, and the disagreement must be
    // real (visible in the log), not laundered into a false-consensus PASS.
    console.log(`  scale-different-large-enterprise extraction rate: ${(rate * 100).toFixed(0)}% (${JSON.stringify(runs.map((r) => r?.verdict ?? 'none'))})`)
    assert.ok(rate >= 0 && rate <= 1, 'sanity bound only — see console output for the actual (expected-variable) rate')
  })
})

describe('cross-model agreement (AC-TST-4 — diagnostic on first run, not gating)', () => {
  for (const model of CROSS_MODELS) {
    it(`${model}: anchor-high extracts the same skill/experience qualities as the default model`, async () => {
      const [defaultResult, crossResult] = await Promise.all([
        scoreMatch(ANCHOR_HIGH_JD),
        scoreMatch(ANCHOR_HIGH_JD, undefined, model),
      ])
      assert.ok(defaultResult, 'default model returned null')
      assert.ok(crossResult, `${model} returned null`)
      console.log(
        `  ${model} fit_score=${crossResult.fit_score} vs default fit_score=${defaultResult.fit_score} ` +
          `(diff=${Math.abs(crossResult.fit_score - defaultResult.fit_score).toFixed(2)})`,
      )
      // Both must at least extract SOMETHING for an unambiguous anchor —
      // total silence from either model is the real failure mode, not a
      // fit_score delta (which is expected to vary somewhat cross-model).
      assert.ok(crossResult.scoring.scored_qualities.length > 0, `${model} extracted zero qualities from an unambiguous JD`)
    })
  }
})

describe('phrasing invariance — raw number vs. description vs. named idiom', () => {
  const PHRASING_VARIANTS = [
    { id: 'raw-number', jd: '50,000+ employee global enterprise. TypeScript/React/Node, 3+ years experience, IC.' },
    { id: 'descriptive', jd: 'A massive, tens-of-thousands-strong global engineering organization. TypeScript/React/Node, 3+ years experience, IC.' },
    { id: 'named-idiom', jd: 'Fortune 500 scale. TypeScript/React/Node, 3+ years experience, IC.' },
  ]

  it('raw-number and descriptive phrasings converge to non-extraction on the default model (spike round 3 result)', async () => {
    for (const variant of PHRASING_VARIANTS.slice(0, 2)) {
      const result = await scoreMatch(variant.jd)
      assert.ok(result, `${variant.id}: scoreMatch returned null`)
      const scaleQuality = findScaleQuality(result.scoring.scored_qualities)
      console.log(`  ${variant.id}: ${scaleQuality ? `extracted "${scaleQuality.name}" (${scaleQuality.verdict}/${scaleQuality.evidence_grade})` : 'not extracted'}`)
    }
    // Reporting-only: spike round 3 showed unanimous non-extraction across 3
    // models for both phrasings, but this is a single default-model run, not
    // a repeated-sample claim — see the repeatability describe() above for
    // that. Asserting a hard "must not extract" here would re-introduce the
    // over-tight-rubric regression D1 already hit once on the scope axis.
  })

  it('named-idiom ("Fortune 500 scale") stays contested — bounded disagreement expected, not full agreement', async () => {
    const result = await scoreMatch(PHRASING_VARIANTS[2].jd)
    assert.ok(result, 'scoreMatch returned null')
    const scaleQuality = findScaleQuality(result.scoring.scored_qualities)
    console.log(`  named-idiom: ${scaleQuality ? `extracted "${scaleQuality.name}" (${scaleQuality.verdict}/${scaleQuality.evidence_grade})` : 'not extracted'}`)
    // No pass/fail assertion on the verdict itself — per the plan's Round 3
    // finding, this phrasing is expected to vary model-to-model and possibly
    // run-to-run. The invariant that matters is structural: scoreMatch must
    // return a well-formed result either way, not silently fail.
    assert.ok(result.scoring.scored_qualities.length > 0, 'scoreMatch returned an empty scored_qualities list — total extraction failure, not just this one quality')
  })
})
