/**
 * Shared fixtures and helpers for public-mcp acceptance tests.
 *
 * Exported surface:
 *   - URL resolvers (PUBLIC_MCP_URL, QUERY_URL, AGENT_CARD_URL)
 *   - TEST_QUESTION / TEST_QUESTION_MARKER — unique-per-run strings that let
 *     the after() hook clean up test rows from observed_queries
 *   - publicMcpPost() / publicMcpToolsList() — HTTP-level call builders
 *   - parseMcpBody() / parseAllMcpEvents() — response parsers for both JSON
 *     and SSE formats
 *   - getSupabase() — lazy-initialised service-role client
 *   - waitForLoggedCall() — polling helper for fire-and-forget DB writes
 *   - cleanupTestRows() — after-hook cleanup by question marker
 *   - isQueryResponseShape() / QueryResponseShape — structural validation
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ── URLs ──────────────────────────────────────────────────

const DEFAULT_PORT = process.env.PORT ?? '3000'

export const PUBLIC_MCP_URL =
  process.env.PUBLIC_MCP_URL ?? `http://localhost:${DEFAULT_PORT}/public-mcp`
export const QUERY_URL =
  process.env.QUERY_URL ?? `http://localhost:${DEFAULT_PORT}/query`
export const AGENT_CARD_URL =
  process.env.AGENT_CARD_URL ?? `http://localhost:${DEFAULT_PORT}/.well-known/agent-card.json`

// ── Canonical test marker ─────────────────────────────────

/** Unique marker embedded in every test question so the after() hook can find + clean rows. */
export const TEST_QUESTION_MARKER = `__test_public_mcp_${Date.now()}__`
export const TEST_QUESTION = `${TEST_QUESTION_MARKER} Does this candidate know TypeScript?`

// ── Request helpers ───────────────────────────────────────

interface PublicMcpPostOpts {
  question?: string
  context?: string
  stream?: boolean
  origin?: string
}

/** POST ask_candidate to /public-mcp. All fields optional — a bare call with no question is still well-formed JSON-RPC. */
export async function publicMcpPost(opts: PublicMcpPostOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (opts.origin) headers.Origin = opts.origin

  const args: Record<string, unknown> = {}
  if (opts.question !== undefined) args.question = opts.question
  if (opts.context !== undefined) args.context = opts.context
  if (opts.stream !== undefined) args.stream = opts.stream

  return fetch(PUBLIC_MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ask_candidate', arguments: args },
    }),
  })
}

/** POST tools/list — cheapest possible request, useful for transport-layer tests. */
export async function publicMcpToolsList(): Promise<Response> {
  return fetch(PUBLIC_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  })
}

// ── Response parsers ──────────────────────────────────────

/** Returns the last JSON payload from either plain JSON or SSE-formatted bodies. */
export function parseMcpBody(text: string): unknown {
  if (text.includes('data:')) {
    const lines = text.split('\n').filter(l => l.startsWith('data:'))
    for (const line of lines.reverse()) {
      try { return JSON.parse(line.slice(5).trim()) } catch { /* skip non-JSON line */ }
    }
    throw new Error(`No parseable data in SSE: ${text.slice(0, 200)}`)
  }
  return JSON.parse(text)
}

/** Returns ALL events from an SSE stream (or a single event wrapped in an array for plain JSON). */
export function parseAllMcpEvents(text: string): unknown[] {
  if (!text.includes('data:')) {
    return [JSON.parse(text)]
  }
  const events: unknown[] = []
  const lines = text.split('\n').filter(l => l.startsWith('data:'))
  for (const line of lines) {
    try { events.push(JSON.parse(line.slice(5).trim())) } catch { /* skip */ }
  }
  return events
}

// ── Supabase helpers ──────────────────────────────────────

let _supabase: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (_supabase) return _supabase
  const url = process.env.SUPA_PROJECT_URL
  const key = process.env.SUPA_SERVICE_ROLE
  if (!url || !key) {
    throw new Error('SUPA_PROJECT_URL and SUPA_SERVICE_ROLE must be set in .env.local')
  }
  _supabase = createClient(url, key)
  return _supabase
}

export interface ObservedQueryRow {
  id: string
  source: string
  question: string
  caller_hint: string | null
  answer: string | null
  confidence: string | null
  sources: unknown
  model: string | null
  latency_ms: number | null
  ip_hash: string | null
  user_agent: string | null
  created_at: string
}

const OBSERVED_QUERIES_COLUMNS =
  'id, source, question, caller_hint, answer, confidence, sources, model, latency_ms, ip_hash, user_agent, created_at'

/**
 * Poll observed_queries for a row matching (question, source). Returns null if
 * nothing appears within timeoutMs. Logging is fire-and-forget from the handler
 * path, so a short polling window is necessary.
 */
export async function waitForLoggedCall(
  question: string,
  source: 'mcp' | 'http',
  timeoutMs = 5000,
  pollIntervalMs = 200,
): Promise<ObservedQueryRow | null> {
  const supabase = getSupabase()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from('observed_queries')
      .select(OBSERVED_QUERIES_COLUMNS)
      .eq('source', source)
      .eq('question', question)
      .order('created_at', { ascending: false })
      .limit(1)
    if (data && data.length > 0) return data[0] as unknown as ObservedQueryRow
    await new Promise(r => setTimeout(r, pollIntervalMs))
  }
  return null
}

/** Deletes all rows from observed_queries whose question contains marker. Returns count. */
export async function cleanupTestRows(marker: string): Promise<number> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('observed_queries')
    .delete()
    .ilike('question', `%${marker}%`)
    .select('id')
  if (error) {
    console.warn(`Cleanup warning: ${error.message}`)
    return 0
  }
  return data?.length ?? 0
}

// ── Response shape ────────────────────────────────────────

export interface QueryResponseShape {
  answer: string
  confidence: 'high' | 'medium' | 'low'
  sources: string[]
  follow_up_suggestions: string[]
  contact?: {
    email?: string
    calendly?: string
  }
  meta?: {
    model?: string
    latency_ms?: number
  }
}

/** Structural guard. Validates required fields; contact/meta are optional. */
export function isQueryResponseShape(obj: unknown): obj is QueryResponseShape {
  if (!obj || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  return (
    typeof o.answer === 'string' &&
    typeof o.confidence === 'string' &&
    ['high', 'medium', 'low'].includes(o.confidence as string) &&
    Array.isArray(o.sources) &&
    Array.isArray(o.follow_up_suggestions)
  )
}
