/**
 * Eval runner for the `/query` engagement rules.
 *
 *   npm run eval:query
 *   npm run eval:query -- --case <id>
 *   npm run eval:query -- --category <name>
 *   npm run eval:query -- --threshold <n>     # override QUERY_THOUGHTS_THRESHOLD
 *   npm run eval:query -- --judge             # add the LLM-as-judge rule
 *
 * Runs each case against `queryProfile()` directly (no HTTP server required;
 * reuses the shared core), scores it with the deterministic rubric in
 * `src/lib/eval-query-answer.ts`, optionally adds a Haiku judge call, and
 * prints per-case PASS/FAIL + a category summary + an overall score. Process
 * exit code is 0 if overall passes; 1 otherwise.
 *
 * The runner is on-demand (makes LLM calls); it is NOT in `test:unit`.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

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
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { judge: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--case') flags.case = argv[++i]
    else if (arg === '--category') flags.category = argv[++i]
    else if (arg === '--threshold') {
      const n = Number(argv[++i])
      if (Number.isFinite(n)) flags.threshold = n
    } else if (arg === '--judge') flags.judge = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage: npm run eval:query [-- <flags>]',
        '',
        '  --case <id>          Run a single case by id',
        '  --category <name>    Run one category (binary|capability|behavioral|off_topic|adversarial|no_data)',
        '  --threshold <n>      Override QUERY_THOUGHTS_THRESHOLD for this run (e.g. 0.5)',
        '  --judge              Add an LLM-as-judge rule (one Haiku call per case)',
        '  --help, -h           Show this',
        '',
      ].join('\n'))
      process.exit(0)
    }
  }
  return flags
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
    '',
  ].join('\n') + '\n')

  const scores: { caseId: string; category: string; pass: boolean; total: number; maxTotal: number }[] = []

  for (const caseDef of selected) {
    process.stdout.write(`\n[${caseDef.id}] (${caseDef.category})\n  Q: ${caseDef.question}\n`)

    const callerHint = caseDef.callerHint ?? 'Unknown caller. Balance structure and readability. Be honest and direct.'
    const result = await queryProfile({ question: caseDef.question, callerHint })
    if ('kind' in result) {
      process.stdout.write(`  FAIL — queryProfile error: ${result.kind}\n`)
      scores.push({ caseId: caseDef.id, category: caseDef.category, pass: false, total: 0, maxTotal: 1 })
      continue
    }

    const score = scoreAnswer(caseDef, result)
    let extraRule: RuleResult | undefined
    if (flags.judge) {
      try {
        const { text } = await generateText({
          model: getModel(),
          maxTokens: 200,
          prompt: buildJudgePrompt(caseDef, result.answer),
        })
        const parsed = parseJSON(text) as { pass?: boolean; reason?: string }
        const pass = Boolean(parsed.pass)
        extraRule = {
          rule: 'judge-llm',
          pass,
          score: pass ? 1 : 0,
          detail: parsed.reason ?? '(judge returned no reason)',
        }
      } catch (err) {
        extraRule = {
          rule: 'judge-llm',
          pass: false,
          score: 0,
          detail: `judge call failed: ${(err as Error).message}`,
        }
      }
    }

    const rules = extraRule ? [...score.rules, extraRule] : score.rules
    // Blocking rules don't contribute to the additive total — match scoreAnswer's math.
    // When a category has only blocking rules, pass rests on those alone.
    const blockingFailed = rules.some((r) => r.blocking && !r.pass)
    const additive = rules.filter((r) => !r.blocking)
    const total = additive.reduce((sum, r) => sum + r.score, 0)
    const maxTotal = additive.length
    const passByThreshold = maxTotal === 0 ? true : total >= maxTotal * PASS_RATIO
    const pass = !blockingFailed && passByThreshold

    process.stdout.write(`  A: ${result.answer.slice(0, 180).replace(/\s+/g, ' ')}${result.answer.length > 180 ? '…' : ''}\n`)
    process.stdout.write(`  confidence=${result.confidence}  sources=${JSON.stringify(result.sources ?? [])}\n`)
    for (const r of rules) {
      const tag = r.blocking ? (r.pass ? '✓ (blocking)' : '✗ BLOCKING-FAIL') : (r.pass ? '✓' : '✗')
      process.stdout.write(`  ${tag} ${r.rule} — ${r.detail}\n`)
    }
    process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'} (additive ${total.toFixed(1)}/${maxTotal}${blockingFailed ? '; blocking-rule failure' : ''})\n`)

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

  process.exit(overallPass === overallTotal ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`Eval crashed: ${(err as Error).message}\n`)
  process.exit(2)
})
