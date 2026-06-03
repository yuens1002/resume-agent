/**
 * Eval runner for the `/query` engagement rules — correctness AND latency.
 *
 *   npm run eval:query
 *   npm run eval:query -- --case <id>
 *   npm run eval:query -- --category <name>
 *   npm run eval:query -- --threshold <n>     # override QUERY_THOUGHTS_THRESHOLD
 *   npm run eval:query -- --judge             # add the LLM-as-judge rule
 *   npm run eval:query -- --runs <n>          # run each case n times, report median latency (default 1)
 *   npm run eval:query -- --baseline          # append the run's aggregate to docs/eval-baselines.md
 *
 * Runs each case against `queryProfile()` directly (no HTTP server required;
 * reuses the shared core), scores it with the deterministic rubric in
 * `src/lib/eval-query-answer.ts`, optionally adds a Haiku judge call, times the
 * query phases, and prints per-case PASS/FAIL + a category summary + a latency
 * report. Process exit code is 0 if overall passes; 1 otherwise.
 *
 * Latency note: upstream (OpenRouter/Haiku) variance is real. Use `--runs 3+`
 * to take the median per case before recording a baseline; treat sub-second
 * deltas between runs as noise, not signal. The runner is on-demand (makes LLM
 * calls); it is NOT in `test:unit`.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs'
import { generateText } from 'ai'
import { getModel } from '../../src/lib/ai.js'
import { parseJSON } from '../../src/lib/parse-json.js'
import { queryProfile } from '../../src/routes/query.js'
import { scoreAnswer, buildJudgePrompt, PASS_RATIO, type RuleResult } from '../../src/lib/eval-query-answer.js'
import { EVAL_CASES, type EvalCase } from './query-eval-cases.js'

// ── CLI parsing ──────────────────────────────────────────────

interface Flags {
  case?: string
  category?: string
  threshold?: number
  judge: boolean
  runs: number
  baseline: boolean
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { judge: false, runs: 1, baseline: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--case') flags.case = argv[++i]
    else if (arg === '--category') flags.category = argv[++i]
    else if (arg === '--threshold') {
      const n = Number(argv[++i])
      if (Number.isFinite(n)) flags.threshold = n
    } else if (arg === '--judge') flags.judge = true
    else if (arg === '--runs') {
      const n = Number(argv[++i])
      if (Number.isFinite(n) && n >= 1) flags.runs = Math.floor(n)
    } else if (arg === '--baseline') flags.baseline = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage: npm run eval:query [-- <flags>]',
        '',
        '  --case <id>          Run a single case by id',
        '  --category <name>    Run one category (binary|capability|behavioral|off_topic|adversarial|no_data|overview)',
        '  --threshold <n>      Override QUERY_THOUGHTS_THRESHOLD for this run (e.g. 0.5)',
        '  --judge              Add an LLM-as-judge rule (one Haiku call per case)',
        '  --runs <n>           Run each case n times; report median latency (default 1)',
        '  --baseline           Append this run\'s aggregate to docs/eval-baselines.md',
        '  --help, -h           Show this',
        '',
      ].join('\n'))
      process.exit(0)
    }
  }
  return flags
}

// ── Latency helpers ──────────────────────────────────────────

interface Sample { total: number; llm: number; retrieval: number }

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

function avg(xs: number[]): number {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0
}

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const BASELINE_PATH = 'docs/eval-baselines.md'
const BASELINE_HEADER = [
  '# Eval baselines',
  '',
  'Correctness + latency snapshots recorded via `npm run eval:query -- --baseline --runs 3`.',
  'Each row aggregates the median-of-N per-case latency. Compare rows to see which',
  'commit moved latency. Upstream (OpenRouter/Haiku) variance is real — treat',
  'sub-second deltas as noise. Optimize latency only with the pass rate held.',
  '',
  '| date | version | runs/case | pass | total p50 | total p95 | llm p50 | retrieval p50 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '',
].join('\n')

function appendBaseline(row: string): void {
  if (!existsSync(BASELINE_PATH)) {
    writeFileSync(BASELINE_PATH, BASELINE_HEADER + row + '\n')
  } else {
    appendFileSync(BASELINE_PATH, row + '\n')
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))

  if (flags.threshold !== undefined) {
    process.env.QUERY_THOUGHTS_THRESHOLD = String(flags.threshold)
  }

  const selected = EVAL_CASES.filter((c) => {
    if (flags.case && c.id !== flags.case) return false
    if (flags.category && c.category !== flags.category) return false
    return true
  })

  if (!selected.length) {
    process.stderr.write(`No cases match filters: case=${flags.case ?? '*'} category=${flags.category ?? '*'}\n`)
    process.exit(2)
  }

  process.stdout.write([
    `Running ${selected.length} case(s)`,
    flags.threshold !== undefined ? `  threshold=${flags.threshold}` : `  threshold=${process.env.QUERY_THOUGHTS_THRESHOLD ?? '0.35 (default)'}`,
    `  judge=${flags.judge ? 'on' : 'off'}`,
    `  runs=${flags.runs}`,
    '',
  ].join('\n') + '\n')

  const scores: { caseId: string; category: string; pass: boolean; total: number; maxTotal: number }[] = []
  const latencyByCase: { caseId: string; category: string; med: Sample }[] = []

  for (const caseDef of selected) {
    process.stdout.write(`\n[${caseDef.id}] (${caseDef.category})\n  Q: ${caseDef.question}\n`)

    const callerHint = caseDef.callerHint ?? 'Unknown caller. Balance structure and readability. Be honest and direct.'

    // Run the query `runs` times, timing only the queryProfile call (not the judge).
    // Score the deterministic rubric on EVERY run and majority-vote the pass — this
    // makes --runs stabilize correctness (kills single-run model variance, e.g.
    // behavioral cases flipping) as well as giving a latency median. At runs=1
    // this is identical to scoring the single run.
    const samples: Sample[] = []
    const runPasses: boolean[] = []
    let result: Awaited<ReturnType<typeof queryProfile>> | undefined
    let lastScore: ReturnType<typeof scoreAnswer> | undefined
    for (let run = 0; run < flags.runs; run++) {
      const t0 = Date.now()
      const r = await queryProfile({ question: caseDef.question, callerHint })
      const totalMs = Date.now() - t0
      result = r
      if ('kind' in r) break // error — stop repeating this case
      samples.push({ total: totalMs, llm: r.meta.latency_ms, retrieval: r.meta.retrieval_ms ?? 0 })
      const s = scoreAnswer(caseDef, r)
      lastScore = s
      runPasses.push(s.pass)
    }

    if (!result || 'kind' in result || !lastScore) {
      process.stdout.write(`  FAIL — queryProfile error: ${result && 'kind' in result ? result.kind : 'no result'}\n`)
      scores.push({ caseId: caseDef.id, category: caseDef.category, pass: false, total: 0, maxTotal: 1 })
      continue
    }

    const med: Sample = {
      total: median(samples.map((s) => s.total)),
      llm: median(samples.map((s) => s.llm)),
      retrieval: median(samples.map((s) => s.retrieval)),
    }
    latencyByCase.push({ caseId: caseDef.id, category: caseDef.category, med })

    // Majority of runs must pass the deterministic rubric.
    const passCount = runPasses.filter(Boolean).length
    const detPass = passCount > runPasses.length / 2

    // The judge (if enabled) runs once on the last result — folded into the verdict.
    let judgeRule: RuleResult | undefined
    if (flags.judge) {
      try {
        const { text } = await generateText({
          model: getModel(),
          maxTokens: 200,
          prompt: buildJudgePrompt(caseDef, result.answer),
        })
        const parsed = parseJSON(text) as { pass?: boolean; reason?: string }
        const jp = Boolean(parsed.pass)
        judgeRule = { rule: 'judge-llm', pass: jp, score: jp ? 1 : 0, detail: parsed.reason ?? '(judge returned no reason)' }
      } catch (err) {
        judgeRule = { rule: 'judge-llm', pass: false, score: 0, detail: `judge call failed: ${(err as Error).message}` }
      }
    }

    const rules = judgeRule ? [...lastScore.rules, judgeRule] : lastScore.rules
    const total = lastScore.total
    const maxTotal = lastScore.maxTotal
    const pass = detPass && (judgeRule ? judgeRule.pass : true)

    process.stdout.write(`  A: ${result.answer.slice(0, 180).replace(/\s+/g, ' ')}${result.answer.length > 180 ? '…' : ''}\n`)
    process.stdout.write(`  confidence=${result.confidence}  sources=${JSON.stringify(result.sources ?? [])}\n`)
    process.stdout.write(`  latency(median of ${samples.length}): total ${med.total}ms  llm ${med.llm}ms  retrieval ${med.retrieval}ms\n`)
    for (const r of rules) {
      const tag = r.blocking ? (r.pass ? '✓ (blocking)' : '✗ BLOCKING-FAIL') : (r.pass ? '✓' : '✗')
      process.stdout.write(`  ${tag} ${r.rule} — ${r.detail}\n`)
    }
    const voteNote = runPasses.length > 1 ? ` [passed ${passCount}/${runPasses.length} runs]` : ''
    process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'} (additive ${total.toFixed(1)}/${maxTotal})${voteNote}\n`)

    scores.push({ caseId: caseDef.id, category: caseDef.category, pass, total, maxTotal })
  }

  // Category summary
  const byCategory = new Map<string, { pass: number; total: number }>()
  for (const s of scores) {
    const acc = byCategory.get(s.category) ?? { pass: 0, total: 0 }
    acc.total++
    if (s.pass) acc.pass++
    byCategory.set(s.category, acc)
  }
  process.stdout.write('\n── Summary ─────────────────────────────────\n')
  for (const [cat, { pass, total }] of byCategory) {
    process.stdout.write(`  ${cat.padEnd(14)} ${pass}/${total}\n`)
  }
  const overallPass = scores.filter((s) => s.pass).length
  const overallTotal = scores.length
  const overallScore = scores.reduce((s, c) => s + c.total, 0)
  const overallMax = scores.reduce((s, c) => s + c.maxTotal, 0)
  process.stdout.write(`  ─────────────────────────────────\n`)
  process.stdout.write(`  Overall:       ${overallPass}/${overallTotal} cases   ${overallScore.toFixed(1)}/${overallMax} rule points\n`)

  // Latency report — aggregate over per-case medians
  const totals = latencyByCase.map((l) => l.med.total)
  const llms = latencyByCase.map((l) => l.med.llm)
  const retrievals = latencyByCase.map((l) => l.med.retrieval)
  if (latencyByCase.length) {
    process.stdout.write('\n── Latency (median per case, aggregated, ms) ─\n')
    process.stdout.write(`  total      p50 ${percentile(totals, 50)}   p95 ${percentile(totals, 95)}   avg ${avg(totals)}\n`)
    process.stdout.write(`  llm        p50 ${percentile(llms, 50)}   p95 ${percentile(llms, 95)}   avg ${avg(llms)}\n`)
    process.stdout.write(`  retrieval  p50 ${percentile(retrievals, 50)}   p95 ${percentile(retrievals, 95)}   avg ${avg(retrievals)}\n`)
    const slowest = [...latencyByCase].sort((a, b) => b.med.total - a.med.total).slice(0, 3)
    process.stdout.write(`  slowest:   ${slowest.map((s) => `${s.caseId} (${s.med.total}ms)`).join(', ')}\n`)
  }

  // Baseline append — deliberate, only on --baseline. Records the current run so
  // git history shows which commit moved latency.
  if (flags.baseline && latencyByCase.length) {
    const date = new Date().toISOString().slice(0, 10)
    const row = `| ${date} | ${readVersion()} | ${flags.runs} | ${overallPass}/${overallTotal} | ${percentile(totals, 50)} | ${percentile(totals, 95)} | ${percentile(llms, 50)} | ${percentile(retrievals, 50)} |`
    appendBaseline(row)
    process.stdout.write(`\n  baseline recorded → ${BASELINE_PATH}\n`)
  }

  process.exit(overallPass === overallTotal ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`Eval crashed: ${(err as Error).message}\n`)
  process.exit(2)
})
