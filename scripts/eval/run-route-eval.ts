/**
 * Eval runner for the route classifier (#195) — the golden-set baseline.
 *
 *   npm run eval:route                       # full set, 3 rounds per case
 *   npm run eval:route -- --rounds <n>       # rounds per case (default 3)
 *   npm run eval:route -- --case <id>        # single case
 *   npm run eval:route -- --source <name>    # one provenance slice (eval-legacy|incident|observed|synthetic)
 *   npm run eval:route -- --model <id>       # judge validation: run a different model
 *                                            # (e.g. anthropic/claude-sonnet-4.5) against the same labels
 *
 * Every (case × round) must match its label for the run to pass — routing is
 * a closed-set classification where the golden labels ARE the spec, so there
 * is no partial credit and no majority vote: a case that flips across rounds
 * is a reliability regression worth failing on. Exit 0 only on 100%.
 *
 * Calls classifyRoute() directly (no HTTP server). Rounds run through a
 * small concurrency pool; a model/provider error counts as a miss, never a
 * silent pass. Like run-eval.ts this makes LLM calls — it is NOT in
 * `test:unit`; the nightly workflow (eval-query.yml) runs it on schedule.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { classifyRoute } from '../../src/lib/route-classifier.js'
import { ROUTE_CASES, type RouteCase } from './route-cases.js'

interface Flags {
  case?: string
  source?: string
  model?: string
  rounds: number
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { rounds: 3 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--case') flags.case = argv[++i]
    else if (arg === '--source') flags.source = argv[++i]
    else if (arg === '--model') flags.model = argv[++i]
    else if (arg === '--rounds') {
      const n = Number(argv[++i])
      if (Number.isFinite(n) && n >= 1) flags.rounds = Math.floor(n)
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage: npm run eval:route [-- <flags>]',
        '',
        '  --case <id>       Run a single case by id',
        '  --source <name>   Run one provenance slice (eval-legacy|incident|observed|synthetic)',
        '  --model <id>      Override the model (judge validation, e.g. anthropic/claude-sonnet-4.5)',
        '  --rounds <n>      Rounds per case (default 3)',
        '  --help, -h        Show this',
        '',
      ].join('\n'))
      process.exit(0)
    }
  }
  return flags
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const idx = i++
        results[idx] = await fn(items[idx])
      }
    }),
  )
  return results
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))

  const selected = ROUTE_CASES.filter((c) => {
    if (flags.case && c.id !== flags.case) return false
    if (flags.source && c.source !== flags.source) return false
    return true
  })
  if (!selected.length) {
    process.stderr.write(`No cases match filters: case=${flags.case ?? '*'} source=${flags.source ?? '*'}\n`)
    process.exit(2)
  }

  process.stdout.write(
    `Route eval: ${selected.length} case(s) × ${flags.rounds} round(s)` +
      `${flags.model ? `  model=${flags.model} (override)` : ''}\n\n`,
  )

  const jobs: { c: RouteCase; round: number }[] = selected.flatMap((c) =>
    Array.from({ length: flags.rounds }, (_, round) => ({ c, round })),
  )
  const outcomes = await pool(jobs, 8, async ({ c }) => {
    try {
      return await classifyRoute(c.question, flags.model)
    } catch (err) {
      return `ERR: ${(err as Error).message.slice(0, 80)}`
    }
  })

  const perCase = new Map<string, string[]>()
  jobs.forEach(({ c }, i) => {
    const got = perCase.get(c.id) ?? []
    got.push(outcomes[i])
    perCase.set(c.id, got)
  })

  let hits = 0
  const misses: string[] = []
  const bySource = new Map<string, { hits: number; total: number }>()
  for (const c of selected) {
    const got = perCase.get(c.id)!
    const ok = got.filter((g) => g === c.expected).length
    hits += ok
    const acc = bySource.get(c.source) ?? { hits: 0, total: 0 }
    acc.hits += ok
    acc.total += flags.rounds
    bySource.set(c.source, acc)
    if (ok < flags.rounds) {
      misses.push(`  ✗ ${c.id}: expected=${c.expected} got=[${got.join(', ')}] (${ok}/${flags.rounds})${c.note ? `\n      note: ${c.note}` : ''}`)
    }
  }

  const total = selected.length * flags.rounds
  process.stdout.write('── Summary ─────────────────────────────────\n')
  for (const [source, { hits: h, total: t }] of bySource) {
    process.stdout.write(`  ${source.padEnd(12)} ${h}/${t}\n`)
  }
  process.stdout.write(`  ─────────────────────────────────\n`)
  process.stdout.write(`  Overall:     ${hits}/${total} (${((hits / total) * 100).toFixed(1)}%)\n`)
  if (misses.length) {
    process.stdout.write(`\n── Misses ──────────────────────────────────\n${misses.join('\n')}\n`)
  }

  process.exit(hits === total ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`Route eval crashed: ${(err as Error).message}\n`)
  process.exit(2)
})
