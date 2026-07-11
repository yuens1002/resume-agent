/**
 * Route classification via the local Claude Code CLI (#201) — a
 * subscription-provider mode for the route-classifier eval, distinct from
 * production's OpenRouter-backed classifyRoute(). This exists so a full
 * live sweep can run against a Claude subscription instead of the shared
 * OpenRouter key (used for CI in Phase B; used here for local dry-runs).
 *
 * Implementation spawns `claude -p <question> --append-system-prompt-file
 * <tmpfile> --output-format json [--model <model>]`, writing
 * ROUTE_CLASSIFIER_RULE to a temp file first (the CLI takes a system-prompt
 * FILE, not an inline string flag). `--output-format json` wraps the reply
 * in a JSON envelope; the answer text is the `.result` field.
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

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Route } from '../../src/lib/route-classifier.js'
import { ROUTES, ROUTE_CLASSIFIER_RULE } from '../../src/lib/route-classifier.js'

const execFile = promisify(execFileCb)

const RETRY_SUFFIX =
  '\n\nRespond with EXACTLY one of: narrate, narrate_fit, open_match_tool — no other text.'

function isRoute(value: string): value is Route {
  return (ROUTES as readonly string[]).includes(value)
}

async function invokeClaudeCode(question: string, systemPromptPath: string, model?: string): Promise<string> {
  const args = ['-p', question, '--append-system-prompt-file', systemPromptPath, '--output-format', 'json']
  if (model) args.push('--model', model)

  // On Windows, `claude` resolves to a .cmd shim — plain execFile can fail
  // with ENOENT because Windows won't exec a .cmd without a shell. Using
  // { shell: true } (the documented Windows spawn approach) handles both
  // the .cmd shim and the plain POSIX binary uniformly.
  const { stdout } = await execFile('claude', args, { shell: true, maxBuffer: 10 * 1024 * 1024 })

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
  const tmpPath = join(tmpdir(), `route-classifier-rule-${randomUUID()}.txt`)
  writeFileSync(tmpPath, ROUTE_CLASSIFIER_RULE)
  try {
    // The retry covers BOTH failure shapes: a parseable envelope whose
    // .result isn't a valid route (model chattiness) AND a corrupted/
    // unparseable envelope or missing .result — "unparseable result" in the
    // spec means either. Only the second attempt's failure propagates.
    let first: string | undefined
    try {
      first = (await invokeClaudeCode(question, tmpPath, model)).trim().toLowerCase()
    } catch {
      first = undefined
    }
    if (first !== undefined && isRoute(first)) return first

    const second = (await invokeClaudeCode(question + RETRY_SUFFIX, tmpPath, model)).trim().toLowerCase()
    if (isRoute(second)) return second

    throw new Error(`claude-code: invalid route after retry: "${second}"`)
  } finally {
    rmSync(tmpPath, { force: true })
  }
}
