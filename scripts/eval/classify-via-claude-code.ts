/**
 * Route classification via the local Claude Code CLI (#201) — a
 * subscription-provider mode for the route-classifier eval, distinct from
 * production's OpenRouter-backed classifyRoute(). This exists so a full
 * live sweep can run against a Claude subscription instead of the shared
 * OpenRouter key (used for CI in Phase B; used here for local dry-runs).
 *
 * Implementation spawns `claude -p --append-system-prompt-file <tmpfile>
 * --output-format json --model <model>` and delivers the QUESTION VIA STDIN
 * (documented `-p` behavior), writing ROUTE_CLASSIFIER_RULE to a temp file
 * first (the CLI takes a system-prompt FILE, not an inline string flag).
 * `--output-format json` wraps the reply in a JSON envelope; the answer text
 * is the `.result` field.
 *
 * Why stdin and not argv: the spawn runs with `shell: true` (required on
 * Windows, below), where argv items are concatenated UNESCAPED into one
 * command line — a newline inside an argv string terminates the command
 * mid-flag-list. Golden-set questions include multi-line bare-JD pastes, and
 * the retry suffix is multi-line too; both silently dropped every flag after
 * the newline when passed as argv (observed live: the CLI answered
 * conversationally with no JSON envelope and no classifier rule). Stdin has
 * no such parsing layer, so visitor text never touches the command line.
 *
 * Auth: locally this uses the developer's existing `claude login` session.
 * In CI (Phase B) auth comes from CLAUDE_CODE_OAUTH_TOKEN — but note that
 * --bare mode does NOT read CLAUDE_CODE_OAUTH_TOKEN, so invocations must
 * run in normal (non-bare) mode.
 *
 * Throws on failure (unparseable JSON, missing .result, or a result outside
 * ROUTES even after one retry) — same throw-on-error contract as
 * classifyRoute, so the runner's errors-count-as-misses handling applies
 * unchanged.
 */

import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Route } from '../../src/lib/route-classifier.js'
import { ROUTES, ROUTE_CLASSIFIER_RULE } from '../../src/lib/route-classifier.js'

/**
 * Explicit default model for CLI runs — the same haiku-4.5 weights production
 * serves via OpenRouter, in the Claude CLI's own model-ID format. Always
 * passed to the CLI (never omitted): the CLI's implicit default follows the
 * developer's saved `/model` preference, which would make results — and the
 * cache key's `model` dimension — silently depend on local configuration.
 */
export const CLAUDE_CODE_DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

const RETRY_SUFFIX =
  '\n\nRespond with EXACTLY one of: narrate, narrate_fit, open_match_tool — no other text.'

function isRoute(value: string): value is Route {
  return (ROUTES as readonly string[]).includes(value)
}

async function invokeClaudeCode(question: string, systemPromptPath: string, model: string): Promise<string> {
  // Every argv item here is static or repo-controlled — visitor text goes via
  // stdin only (see header). The tmpfile path is quoted in case a fork's temp
  // dir contains spaces.
  const args = ['-p', '--append-system-prompt-file', `"${systemPromptPath}"`, '--output-format', 'json', '--model', model]

  // On Windows, `claude` resolves to a .cmd shim — plain spawn/execFile fails
  // with ENOENT because Windows won't exec a .cmd without a shell. Using
  // { shell: true } (the documented Windows spawn approach) handles both
  // the .cmd shim and the plain POSIX binary uniformly.
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, { shell: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`claude-code: exit ${code}: ${err.slice(0, 200)}`))
      else resolve(out)
    })
    child.stdin.write(question)
    child.stdin.end()
  })

  let parsed: { result?: string }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`claude-code: unparseable JSON output: ${stdout.slice(0, 200)}`)
  }
  if (typeof parsed.result !== 'string') {
    throw new Error(`claude-code: no .result field in output: ${stdout.slice(0, 200)}`)
  }
  return parsed.result
}

/**
 * Classify one visitor question via the Claude Code CLI. Retries ONCE with
 * an augmented, more forceful prompt if the first result is unparseable or
 * not one of ROUTES; throws on a second failure.
 */
export async function classifyRouteViaClaudeCode(question: string, model?: string): Promise<Route> {
  const effectiveModel = model ?? CLAUDE_CODE_DEFAULT_MODEL
  const tmpPath = join(tmpdir(), `route-classifier-rule-${randomUUID()}.txt`)
  writeFileSync(tmpPath, ROUTE_CLASSIFIER_RULE)
  try {
    // The retry covers BOTH failure shapes: a parseable envelope whose
    // .result isn't a valid route (model chattiness) AND a corrupted/
    // unparseable envelope or missing .result — "unparseable result" in the
    // spec means either. Only the second attempt's failure propagates.
    let first: string | undefined
    try {
      first = (await invokeClaudeCode(question, tmpPath, effectiveModel)).trim().toLowerCase()
    } catch {
      first = undefined
    }
    if (first !== undefined && isRoute(first)) return first

    const second = (await invokeClaudeCode(question + RETRY_SUFFIX, tmpPath, effectiveModel)).trim().toLowerCase()
    if (isRoute(second)) return second

    throw new Error(`claude-code: invalid route after retry: "${second}"`)
  } finally {
    rmSync(tmpPath, { force: true })
  }
}
