/**
 * Result cache for the route-classifier eval runner (#201).
 *
 * Dev-iteration cost fix: re-running `npm run eval:route` re-pays for every
 * case on every round, even when only one label changed — this was ~$10
 * across two runs while developing the classifier (#195-#200) and twice
 * exhausted the shared OpenRouter monthly credit cap (prod and eval share
 * OPENROUTER_API_KEY), 500-ing production. Caching a verdict per
 * (rule, question, model, provider, round) means a rule-text tweak or a
 * single new case only re-pays for what actually changed.
 *
 * The key includes `round` so bumping `--rounds` only computes the NEW
 * rounds live — existing rounds replay from cache instead of re-running.
 *
 * The key includes the full rule TEXT (not a version number) so any edit to
 * ROUTE_CLASSIFIER_RULE changes every derived key and auto-orphans every
 * stale entry — the same principle as PROMPT_VERSION in src/routes/query.ts,
 * just derived from the string itself instead of a hand-bumped constant.
 *
 * The cache file is COMMITTED to git (NOT gitignored) — do not add
 * scripts/eval/.cache/ to .gitignore. This lets ephemeral CI checkouts and
 * label-only PRs replay instantly instead of re-running the full live sweep,
 * and the file itself is an auditable record of validated verdicts (what
 * was run, against which rule text, and what it returned).
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const CACHE_PATH = 'scripts/eval/.cache/route-classifier-verdicts.json'

export function cacheKey(rule: string, question: string, model: string, provider: string, round: number): string {
  return createHash('sha256').update([rule, question, model, provider, String(round)].join(' ')).digest('hex')
}

export function loadCache(path = CACHE_PATH): Record<string, string> {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function saveCache(cache: Record<string, string>, path = CACHE_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cache, null, 2) + '\n')
}
