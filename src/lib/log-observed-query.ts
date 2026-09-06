/**
 * Fire-and-forget logger for public query traffic.
 *
 * Writes one row to `observed_queries` per call. Called by:
 *   - POST /query (HTTP) with source='http'
 *   - ask_candidate MCP tool with source='mcp'
 *
 * Contract: this function MUST NEVER throw. Insert failures are swallowed
 * and surfaced to stderr only. Logging is observability, never the critical
 * path — the caller's response must not be affected by DB hiccups.
 *
 * Streaming callers may pass partial payloads (answer only, no structured
 * envelope). For non-streaming callers the full response shape is logged.
 */

import { createHash, randomBytes } from 'node:crypto'
import { supabase } from './supabase.js'
import type { QueryResponse } from '../types.js'

interface LogInput {
  source: 'http' | 'mcp'
  question: string
  caller_hint?: string
  response: Pick<QueryResponse, 'answer'> & Omit<Partial<QueryResponse>, 'meta'> & {
    meta?: Partial<QueryResponse['meta']>
  }
  latency_ms: number
  ip?: string
  user_agent?: string
}

/**
 * Salt used to hash raw IPs before storage. Prefer IP_HASH_SALT from env; if
 * unset, generate a cryptographically random salt at boot and warn. A random
 * boot-time salt means ip_hash values change across restarts (which is fine
 * for short-horizon abuse detection); a hard-coded default would be trivially
 * reversible across IPv4 space and defeats the "no PII" goal.
 */
const IP_SALT = (() => {
  const fromEnv = process.env.IP_HASH_SALT
  if (fromEnv && fromEnv.length >= 16) return fromEnv
  const random = randomBytes(32).toString('hex')
  if (!fromEnv) {
    console.warn(
      '[log-observed-query] IP_HASH_SALT is unset — generated a random boot-time salt. ' +
        'ip_hash values will not be stable across restarts. Set IP_HASH_SALT in env to fix.',
    )
  } else {
    console.warn(
      '[log-observed-query] IP_HASH_SALT is set but too short (<16 chars) — using a random boot-time salt instead.',
    )
  }
  return random
})()

function hashIp(ip: string | undefined): string | null {
  if (!ip) return null
  return createHash('sha256').update(`${ip}:${IP_SALT}`).digest('hex')
}

/**
 * Build the observed_queries row from a log input. Pure and exported so the
 * column mapping — including the phase-timing fields (`llm_ms`, `retrieval_ms`)
 * and the provider/finish_reason diagnostics (#189) — is unit-testable without
 * a live DB. `latency_ms` is the wall-clock total; `llm_ms` / `retrieval_ms` /
 * `provider` / `finish_reason` come from the response meta and are null when
 * absent. Streaming callers now supply `model` and `finish_reason` (#251) but
 * still no `provider` or `retrieval_ms`, and their `llm_ms` is wall-clock for
 * the whole request rather than the generation span alone — that column means
 * different things by `source`.
 */
export function buildObservedQueryRow(input: LogInput, ipHash: string | null) {
  return {
    source: input.source,
    question: input.question,
    caller_hint: input.caller_hint ?? null,
    answer: input.response.answer ?? null,
    confidence: input.response.confidence ?? null,
    sources: input.response.sources ?? null,
    model: input.response.meta?.model ?? null,
    provider: input.response.meta?.provider ?? null,
    finish_reason: input.response.meta?.finish_reason ?? null,
    // Which route the classifier picked (#195), for the production-traffic
    // accuracy loop — null for narrated answers (no tool call) and for
    // streaming callers that log a partial payload with no action_intent.
    action_intent: input.response.action_intent?.tool ?? null,
    // Whether the classifier flagged a fit/suitability question (#199) —
    // logged so the judge sweep can score the full three-way route decision
    // (narrate / narrate_fit / open_match_tool), not just the tool binary.
    // Null (not false) when the payload is partial (streaming callers).
    fit_question: input.response.fit_question ?? null,
    latency_ms: input.latency_ms,
    llm_ms: input.response.meta?.latency_ms ?? null,
    retrieval_ms: input.response.meta?.retrieval_ms ?? null,
    ip_hash: ipHash,
    user_agent: input.user_agent ?? null,
  }
}

export async function logObservedQuery(input: LogInput): Promise<void> {
  try {
    const { error } = await supabase
      .from('observed_queries')
      .insert(buildObservedQueryRow(input, hashIp(input.ip)))
    if (error) {
      // Supabase returns { error } without throwing for most failures; capture it.
      console.warn('[log-observed-query] insert returned error:', error.message)
    }
  } catch (err) {
    // Defensive catch for unexpected throws (e.g. client-side validation).
    console.warn('[log-observed-query] insert threw unexpectedly:', (err as Error).message)
  }
}
