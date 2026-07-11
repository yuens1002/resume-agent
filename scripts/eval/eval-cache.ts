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
  // JSON encoding, not delimiter-joining: rule and question contain arbitrary
  // text (including any delimiter), so a joined string lets two different
  // tuples collide into one key — an incorrect cache hit, the worst failure
  // mode a cache can have. JSON.stringify preserves the tuple boundaries.
  return createHash('sha256').update(JSON.stringify([rule, question, model, provider, round])).digest('hex')
}

export function loadCache(path = CACHE_PATH): Record<string, string> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    // A raw JSON.parse error hides WHICH file is broken — the likely cause is
    // a merge conflict left in the committed cache. Name the path and the fix.
    throw new Error(
      `eval cache at ${path} is not valid JSON (merge conflict markers?) — fix or delete the file and re-run: ${(err as Error).message}`,
    )
  }
}

export function saveCache(cache: Record<string, string>, path = CACHE_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cache, null, 2) + '\n')
}
