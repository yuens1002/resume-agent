/**
 * Eval runner for /match's extraction-first quality scoring
 * (docs/plans/match-quality-extraction.md, deliverable D5).
 *
 *   npm run eval:match                  # full 21-case set
 *   npm run eval:match -- --case <id>   # single case
 *   npm run eval:match -- --model <id>  # override MATCH_MODEL for this run
 *   npm run eval:match -- --help
 *
 * For each case, calls the real scoreMatch() (live model call, no HTTP
 * server) and checks every QualityExpectation in match-eval-cases.ts against
 * the actual scored_qualities returned. Also reports the fit_score
 * distribution (mean/sd) across the run — directly comparable to #241's
 * "experience p50=1.00, sd=0.053" framing, so the compression this redesign
 * targets is observable here rather than inferred.
 *
 * Not part of `test:unit` (live model calls, real cost/latency) — run
 * on-demand or from a scheduled workflow, matching run-route-eval.ts's
 * convention.
 */

import './eval-env.js'

import { scoreMatch } from '../../src/lib/score-match.js'
import type { MatchScoredQuality } from '../../src/types.js'
import { MATCH_EVAL_CASES, type MatchEvalCase, type QualityExpectation } from './match-eval-cases.js'

interface Flags {
  case?: string
  model?: string
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--case') flags.case = argv[++i]
    else if (arg === '--model') flags.model = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage: npm run eval:match [-- <flags>]',
        '',
        '  --case <id>   Run a single case by id',
        '  --model <id>  Override MATCH_MODEL for this run',
        '  --help, -h    Show this',
        '',
      ].join('\n'))
      process.exit(0)
    }
  }
  return flags
}

interface ExpectationResult {
  pass: boolean
  detail: string
}

function checkExpectation(exp: QualityExpectation, scored: MatchScoredQuality[]): ExpectationResult {
  const candidates = scored.filter(
    (q) => exp.nameMatch.test(q.name) && (!exp.category || q.category === exp.category),
  )

  if (candidates.length === 0) {
    if (exp.mustBeExtracted === false) {
      return { pass: true, detail: 'not extracted (acceptable — see note)' }
    }
    return { pass: false, detail: `expected a "${exp.category ?? 'any category'}" quality matching ${exp.nameMatch} — none extracted` }
  }

  // Any matching candidate satisfying both constraints is a pass — the model
  // may extract the same underlying requirement as more than one quality.
  for (const q of candidates) {
    const verdictOk = !exp.verdict || exp.verdict.includes(q.verdict)
    const evidenceOk = !exp.evidenceGrade || exp.evidenceGrade.includes(q.evidence_grade)
    if (verdictOk && evidenceOk) {
      return { pass: true, detail: `"${q.name}" → ${q.verdict}/${q.evidence_grade}` }
    }
  }

  const got = candidates.map((q) => `"${q.name}" → ${q.verdict}/${q.evidence_grade}`).join('; ')
  return {
    pass: false,
    detail: `found ${candidates.length} candidate(s) but none matched verdict∈[${exp.verdict?.join(',') ?? '*'}] evidence∈[${exp.evidenceGrade?.join(',') ?? '*'}] — got: ${got}`,
  }
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
}

function stdev(xs: number[]): number {
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

async function runCase(c: MatchEvalCase, model?: string): Promise<{ fitScore: number | null; results: ExpectationResult[] }> {
  const result = await scoreMatch(c.jobDescription, undefined, model)
  if (!result) return { fitScore: null, results: c.expectations.map(() => ({ pass: false, detail: 'scoreMatch returned null (model/parse error)' })) }
  const results = c.expectations.map((exp) => checkExpectation(exp, result.scoring.scored_qualities))
  return { fitScore: result.fit_score, results }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const selected = flags.case ? MATCH_EVAL_CASES.filter((c) => c.id === flags.case) : MATCH_EVAL_CASES
  if (!selected.length) {
    process.stderr.write(`No case matches id: ${flags.case}\n`)
    process.exit(2)
  }

  process.stdout.write(`Match eval: ${selected.length} case(s)${flags.model ? `  model=${flags.model} (override)` : ''}\n\n`)

  const fitScores: number[] = []
  let expTotal = 0
  let expPassed = 0
  const failures: string[] = []

  for (const c of selected) {
    const { fitScore, results } = await runCase(c, flags.model)
    if (fitScore !== null) fitScores.push(fitScore)

    const casePassed = results.filter((r) => r.pass).length
    expTotal += results.length
    expPassed += casePassed
    const mark = casePassed === results.length ? '✓' : '✗'
    process.stdout.write(`  ${mark} ${c.id} [${c.axis}] fit_score=${fitScore ?? 'ERR'} (${casePassed}/${results.length} expectations)\n`)

    results.forEach((r, i) => {
      if (!r.pass) {
        failures.push(`  ✗ ${c.id} expectation ${i}: ${c.expectations[i].note}\n      ${r.detail}`)
      }
    })
  }

  process.stdout.write('\n── Summary ─────────────────────────────────\n')
  process.stdout.write(`  Expectations: ${expPassed}/${expTotal}\n`)
  if (fitScores.length) {
    process.stdout.write(
      `  fit_score:    mean=${mean(fitScores).toFixed(3)} sd=${stdev(fitScores).toFixed(3)} ` +
        `min=${Math.min(...fitScores).toFixed(2)} max=${Math.max(...fitScores).toFixed(2)} (n=${fitScores.length})\n`,
    )
  }
  if (failures.length) {
    process.stdout.write(`\n── Failures ─────────────────────────────────\n${failures.join('\n')}\n`)
  }

  process.exit(expPassed === expTotal ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`Match eval crashed: ${(err as Error).message}\n`)
  process.exit(2)
})
