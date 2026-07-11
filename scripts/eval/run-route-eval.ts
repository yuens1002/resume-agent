/**
 * Eval runner for the route classifier (#195) — the golden-set baseline.
 *
 *   npm run eval:route                       # full set, 3 rounds per case
 *   npm run eval:route -- --rounds <n>       # rounds per case (default 3)
 *   npm run eval:route -- --case <id>        # single case
 *   npm run eval:route -- --source <name>    # one provenance slice (eval-legacy|incident|observed|synthetic)
 *   npm run eval:route -- --model <id>       # judge validation: run a different model
 *                                            # (e.g. anthropic/claude-sonnet-4.5) against the same labels
 *   npm run eval:route -- --provider <name>  # openrouter (default) | claude-code
 *   npm run eval:route -- --no-cache         # bypass the result cache (#201), force live calls
 *
 * Every (case × round) must match its label for the run to pass — routing is
 * a closed-set classification where the golden labels ARE the spec, so there
 * is no partial credit and no majority vote: a case that flips across rounds
 * is a reliability regression worth failing on. Exit 0 only on 100%.
 *
 * Calls classifyRoute() directly (no HTTP server) for the default
 * `openrouter` provider, or classifyRouteViaClaudeCode() for `claude-code`
 * (#201's subscription-provider mode). Rounds run through a small
 * concurrency pool; a model/provider error counts as a miss, never a silent
 * pass. Like run-eval.ts this makes LLM calls — it is NOT in `test:unit`;
 * the nightly workflow (eval-query.yml) runs it on schedule.
 *
 * Result cache (#201): verdicts are keyed by (rule text, question, model,
 * provider, round) and persisted to scripts/eval/.cache/ — see eval-cache.ts
 * for why. Enabled by default; pass --no-cache to force every case live.
 */

// First import: a side-effect import evaluates before ESM's static import
// graph reaches ai.ts (imported transitively via route-classifier.js below),
// so this must run before ai.ts's module-level client reads
// OPENROUTER_API_KEY. Mirrors ai.ts's own `import './env.js'` idiom.
import './eval-env.js'

import { classifyRoute, ROUTE_CLASSIFIER_RULE } from '../../src/lib/route-classifier.js'
import { MODEL } from '../../src/lib/ai.js'
import { classifyRouteViaClaudeCode, CLAUDE_CODE_DEFAULT_MODEL } from './classify-via-claude-code.js'
import { cacheKey, loadCache, saveCache } from './eval-cache.js'
import { ROUTE_CASES, type RouteCase } from './route-cases.js'

interface Flags {
  case?: string
  source?: string
  model?: string
  rounds: number
  provider: 'openrouter' | 'claude-code'
  cache: boolean
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { rounds: 3, provider: 'openrouter', cache: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--case') flags.case = argv[++i]
    else if (arg === '--source') flags.source = argv[++i]
    else if (arg === '--model') flags.model = argv[++i]
    else if (arg === '--provider') {
      const p = argv[++i]
      if (p === 'openrouter' || p === 'claude-code') flags.provider = p
    } else if (arg === '--no-cache') flags.cache = false
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
        '  --provider <name> openrouter (default) | claude-code',
        '  --no-cache        Bypass the result cache; force live calls',
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

  // The cache key's model dimension must reflect what actually executes:
  // without --model, the claude-code provider pins CLAUDE_CODE_DEFAULT_MODEL
  // (never the CLI's local /model preference), while openrouter uses the
  // production default. Keying claude-code entries under the OpenRouter MODEL
  // id would let two different serving paths share verdicts incorrectly.
  const effectiveModel = flags.model ?? (flags.provider === 'claude-code' ? CLAUDE_CODE_DEFAULT_MODEL : MODEL)

  process.stdout.write(
    `Route eval: ${selected.length} case(s) × ${flags.rounds} round(s)` +
      `  provider=${flags.provider}  cache=${flags.cache ? 'on' : 'off'}` +
      `${flags.model ? `  model=${flags.model} (override)` : ''}\n\n`,
  )

  // Always load the full existing cache (even under --no-cache) so that
  // persisting at the end merges in fresh verdicts without discarding
  // entries for keys outside this run's job list — --no-cache only skips
  // *reading* a hit for this run's own keys, it must never destroy the rest
  // of the committed cache file.
  const cache = loadCache()
  const newlyCached = new Map<string, string>()

  const jobs: { c: RouteCase; round: number }[] = selected.flatMap((c) =>
    Array.from({ length: flags.rounds }, (_, round) => ({ c, round })),
  )
  const poolSize = flags.provider === 'claude-code' ? 4 : 8
  const outcomes = await pool(jobs, poolSize, async ({ c, round }) => {
    const key = cacheKey(ROUTE_CLASSIFIER_RULE, c.question, effectiveModel, flags.provider, round)
    if (flags.cache && key in cache) return cache[key]
    try {
      const verdict =
        flags.provider === 'claude-code'
          ? await classifyRouteViaClaudeCode(c.question, flags.model)
          : await classifyRoute(c.question, flags.model)
      newlyCached.set(key, verdict)
      return verdict
    } catch (err) {
      return `ERR: ${(err as Error).message.slice(0, 80)}`
    }
  })

  if (newlyCached.size) {
    const merged = { ...cache, ...Object.fromEntries(newlyCached) }
    saveCache(merged)
  }

  const perCase = new Map<string, string[]>()
  jobs.forEach(({ c }, i) => {
    const got = perCase.get(c.id) ?? []
    got.push(outcomes[i])
    perCase.set(c.id, got)
  })

  // Cases annotated cli_unstable are known harness divergences on the
  // claude-code provider (see RouteCase.cli_unstable): they run and are
  // reported, but only GATING cases decide the exit code there. On the
  // openrouter provider (the true serving path, incl. the weekly parity
  // run) every case gates — the annotation never weakens the real check.
  const gates = (c: RouteCase): boolean => flags.provider !== 'claude-code' || !c.cli_unstable

  let hits = 0
  let gatingHits = 0
  let gatingTotal = 0
  const misses: string[] = []
  const nonGating: string[] = []
  const bySource = new Map<string, { hits: number; total: number }>()
  for (const c of selected) {
    const got = perCase.get(c.id)!
    const ok = got.filter((g) => g === c.expected).length
    hits += ok
    const acc = bySource.get(c.source) ?? { hits: 0, total: 0 }
    acc.hits += ok
    acc.total += flags.rounds
    bySource.set(c.source, acc)
    if (gates(c)) {
      gatingHits += ok
      gatingTotal += flags.rounds
      if (ok < flags.rounds) {
        misses.push(`  ✗ ${c.id}: expected=${c.expected} got=[${got.join(', ')}] (${ok}/${flags.rounds})${c.note ? `\n      note: ${c.note}` : ''}`)
      }
    } else {
      nonGating.push(`  ${ok === flags.rounds ? '✓' : '~'} ${c.id}: expected=${c.expected} got=[${got.join(', ')}] (${ok}/${flags.rounds})\n      cli_unstable: ${c.cli_unstable}`)
    }
  }

  const total = selected.length * flags.rounds
  process.stdout.write('── Summary ─────────────────────────────────\n')
  for (const [source, { hits: h, total: t }] of bySource) {
    process.stdout.write(`  ${source.padEnd(12)} ${h}/${t}\n`)
  }
  process.stdout.write(`  ─────────────────────────────────\n`)
  process.stdout.write(`  Overall:     ${hits}/${total} (${((hits / total) * 100).toFixed(1)}%)\n`)
  if (gatingTotal !== total) {
    process.stdout.write(`  Gating:      ${gatingHits}/${gatingTotal} (${nonGating.length} known-unstable case(s) reported below, non-gating on this provider)\n`)
  }
  if (misses.length) {
    process.stdout.write(`\n── Misses ──────────────────────────────────\n${misses.join('\n')}\n`)
  }
  if (nonGating.length) {
    process.stdout.write(`\n── Known-unstable on claude-code (non-gating) ─\n${nonGating.join('\n')}\n`)
  }

  process.exit(gatingHits === gatingTotal ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`Route eval crashed: ${(err as Error).message}\n`)
  process.exit(2)
})
