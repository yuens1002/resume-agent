/**
 * Fire-and-forget logger for public query traffic.
 *
 * Writes one row to `observed_queries` per call. Called by:
 *   - POST /query (HTTP) with source='http'
 *   - ask_candidate MCP tool with source='mcp'
 *
 * Contract: this function MUST NEVER throw. Insert failures are swallowed
 * and logged to stderr only. Logging is observability, never the critical
 * path — the caller's response must not be affected by DB hiccups.
 *
 * Streaming callers may pass partial payloads (answer only, no structured
 * envelope). For non-streaming callers the full response shape is logged.
 */

import { createHash } from 'node:crypto'
import { supabase } from './supabase.js'
import type { QueryResponse } from '../types.js'

interface LogInput {
  source: 'http' | 'mcp'
  question: string
  caller_hint?: string
  response: Pick<QueryResponse, 'answer'> & Partial<QueryResponse>
  latency_ms: number
  ip?: string
  user_agent?: string
}

/** Salt is rotated by redeploy. Raw IPs never land in the DB. */
const IP_SALT = process.env.IP_HASH_SALT ?? 'resume-agent-default-salt-rotate-me'

function hashIp(ip: string | undefined): string | null {
  if (!ip) return null
  return createHash('sha256').update(`${ip}:${IP_SALT}`).digest('hex')
}

export async function logObservedQuery(input: LogInput): Promise<void> {
  try {
    await supabase.from('observed_queries').insert({
      source: input.source,
      question: input.question,
      caller_hint: input.caller_hint ?? null,
      answer: input.response.answer ?? null,
      confidence: input.response.confidence ?? null,
      sources: input.response.sources ?? null,
      model: input.response.meta?.model ?? null,
      latency_ms: input.latency_ms,
      ip_hash: hashIp(input.ip),
      user_agent: input.user_agent ?? null,
    })
  } catch (err) {
    // Swallow — logging must never break the response path
    console.warn('[log-observed-query] insert failed, continuing:', (err as Error).message)
  }
}
