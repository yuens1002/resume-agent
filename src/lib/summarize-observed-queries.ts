import { supabase } from './supabase.js'
import { z } from 'zod'

// ── Types ───────────────────────────────────────────────────

export interface ObservedQuery {
  source: 'mcp' | 'http'
  question: string
  caller_hint: string | null
  user_agent: string | null
  ip_hash: string | null
  model: string | null
  latency_ms: number | null
  created_at: string
}

export const SummarizeInputSchema = z.object({
  since: z.string().datetime().optional().describe('ISO timestamp lower bound. Defaults to 7 days ago.'),
  until: z.string().datetime().optional().describe('ISO timestamp upper bound. Defaults to now.'),
  source: z.enum(['mcp', 'http']).optional().describe('Filter to one surface. Omit for both.'),
  caller_hint: z.string().optional().describe('Filter by caller_hint prefix (e.g. "ATS", "recruiter").'),
  bucket: z.enum(['hour', 'day', 'week']).optional().default('day').describe('Time bucket for the trend series.'),
  top_n: z.number().int().min(1).max(50).optional().default(10).describe('How many rows to include in top-N lists.'),
  format: z.enum(['text', 'json']).optional().default('text').describe('"text" returns a human summary; "json" returns the raw envelope.'),
})

export type SummarizeInput = z.infer<typeof SummarizeInputSchema>

export interface SummarizeEnvelope {
  window: { since: string; until: string; days: number }
  totals: {
    count: number
    by_source: { mcp: number; http: number }
    distinct_user_agents: number
    distinct_ip_hashes: number
  }
  latency: {
    avg_ms: number
    p50_ms: number
    p95_ms: number
    max_ms: number
  }
  top_caller_hints: { caller_hint: string | null; count: number }[]
  top_user_agents: { user_agent: string | null; count: number }[]
  top_questions: { question: string; count: number }[]
  top_models: { model: string | null; count: number }[]
  trend: { bucket_start: string; count: number }[]
  truncated?: boolean
}

// ── Core aggregation function ───────────────────────────────

export function aggregateObservedQueries(rows: ObservedQuery[], input: SummarizeInput): SummarizeEnvelope {
  const top_n = input.top_n ?? 10
  const bucket = input.bucket ?? 'day'

  const until = input.until ? new Date(input.until) : new Date()
  const since = input.since ? new Date(input.since) : new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000)

  // Validate: since must not be after until
  if (input.since && input.until && new Date(input.since) > new Date(input.until)) {
    throw new Error('Invalid window: "since" must not be after "until"')
  }

  // Filter rows
  let filtered = rows.filter(r => {
    const created = new Date(r.created_at)
    if (created < since || created > until) return false
    if (input.source && r.source !== input.source) return false
    if (input.caller_hint && !(r.caller_hint?.startsWith(input.caller_hint))) return false
    return true
  })

  // Hard cap at 10k rows
  let truncated = false
  if (filtered.length > 10000) {
    filtered = filtered.slice(0, 10000)
    truncated = true
  }

  // Count by source
  const bySource = { mcp: 0, http: 0 }
  for (const r of filtered) {
    if (r.source === 'mcp') bySource.mcp++
    else bySource.http++
  }

  // Distinct user_agents and ip_hashes
  const userAgents = new Set(filtered.map(r => r.user_agent).filter(Boolean))
  const ipHashes = new Set(filtered.map(r => r.ip_hash).filter(Boolean))

  // Latency stats
  const latencies = filtered.map(r => r.latency_ms).filter((l): l is number => l !== null)
  const sortedLatencies = [...latencies].sort((a, b) => a - b)
  const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0
  const p50Ms = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] ?? 0
  const p95Ms = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] ?? 0
  const maxMs = sortedLatencies[sortedLatencies.length - 1] ?? 0

  // Top caller_hints
  const callerHintCounts = new Map<string | null, number>()
  for (const r of filtered) {
    const key = r.caller_hint
    callerHintCounts.set(key, (callerHintCounts.get(key) ?? 0) + 1)
  }
  const topCallerHints = [...callerHintCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top_n)
    .map(([caller_hint, count]) => ({ caller_hint, count }))

  // Top user_agents
  const userAgentCounts = new Map<string | null, number>()
  for (const r of filtered) {
    const key = r.user_agent
    userAgentCounts.set(key, (userAgentCounts.get(key) ?? 0) + 1)
  }
  const topUserAgents = [...userAgentCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top_n)
    .map(([user_agent, count]) => ({ user_agent, count }))

  // Top questions (normalized: lowercase + trim + strip trailing punctuation)
  const stripPunctuation = (s: string) => s.replace(/[.!?,:;]+$/, '')
  const questionCounts = new Map<string, { original: string; count: number }>()
  for (const r of filtered) {
    const normalized = stripPunctuation(r.question.toLowerCase().trim())
    const existing = questionCounts.get(normalized)
    if (existing) {
      existing.count++
    } else {
      questionCounts.set(normalized, { original: r.question, count: 1 })
    }
  }
  const topQuestions = [...questionCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, top_n)
    .map(({ original, count }) => ({ question: original, count }))

  // Top models
  const modelCounts = new Map<string | null, number>()
  for (const r of filtered) {
    const key = r.model
    modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1)
  }
  const topModels = [...modelCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top_n)
    .map(([model, count]) => ({ model, count }))

  // Trend (time bucketing)
  const bucketMs = bucket === 'hour' ? 60 * 60 * 1000 : bucket === 'week' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  const trendMap = new Map<string, number>()
  for (const r of filtered) {
    const created = new Date(r.created_at)
    const bucketTime = Math.floor(created.getTime() / bucketMs) * bucketMs
    const bucketStart = bucket === 'day' || bucket === 'week'
      ? new Date(bucketTime).toISOString().slice(0, 10)
      : new Date(bucketTime).toISOString()
    trendMap.set(bucketStart, (trendMap.get(bucketStart) ?? 0) + 1)
  }
  const trend = [...trendMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket_start, count]) => ({ bucket_start, count }))

  const days = Math.round((until.getTime() - since.getTime()) / (24 * 60 * 60 * 1000))

  return {
    window: { since: since.toISOString(), until: until.toISOString(), days },
    totals: {
      count: filtered.length,
      by_source: bySource,
      distinct_user_agents: userAgents.size,
      distinct_ip_hashes: ipHashes.size,
    },
    latency: { avg_ms: avgMs, p50_ms: p50Ms, p95_ms: p95Ms, max_ms: maxMs },
    top_caller_hints: topCallerHints,
    top_user_agents: topUserAgents,
    top_questions: topQuestions,
    top_models: topModels,
    trend,
    ...(truncated && { truncated: true }),
  }
}

// ── Text formatter (matches thought_stats style) ────────────

export function formatEnvelopeToText(envelope: SummarizeEnvelope): string {
  const lines: string[] = [
    `Query Traffic Summary (${envelope.window.days} days)`,
    '',
    `Total queries: ${envelope.totals.count}`,
    `  by source: MCP: ${envelope.totals.by_source.mcp}, HTTP: ${envelope.totals.by_source.http}`,
    `  distinct user-agents: ${envelope.totals.distinct_user_agents}`,
    `  distinct IPs: ${envelope.totals.distinct_ip_hashes}`,
  ]

  if (envelope.latency.avg_ms > 0) {
    lines.push('', 'Latency:')
    lines.push(`  avg: ${envelope.latency.avg_ms}ms, p50: ${envelope.latency.p50_ms}ms, p95: ${envelope.latency.p95_ms}ms, max: ${envelope.latency.max_ms}ms`)
  }

  if (envelope.top_caller_hints.length) {
    lines.push('', 'Top caller hints:')
    for (const { caller_hint, count } of envelope.top_caller_hints.slice(0, 5)) {
      lines.push(`  ${caller_hint ?? '(none)'}: ${count}`)
    }
  }

  if (envelope.top_user_agents.length) {
    lines.push('', 'Top user-agents:')
    for (const { user_agent, count } of envelope.top_user_agents.slice(0, 5)) {
      lines.push(`  ${user_agent?.slice(0, 60) ?? '(none)'}: ${count}`)
    }
  }

  if (envelope.top_questions.length) {
    lines.push('', 'Top questions:')
    for (const { question, count } of envelope.top_questions.slice(0, 5)) {
      lines.push(`  ${question.slice(0, 80)}: ${count}`)
    }
  }

  if (envelope.top_models.length) {
    lines.push('', 'Top models:')
    for (const { model, count } of envelope.top_models.slice(0, 5)) {
      lines.push(`  ${model ?? '(none)'}: ${count}`)
    }
  }

  if (envelope.trend.length) {
    lines.push('', 'Trend:')
    for (const { bucket_start, count } of envelope.trend.slice(0, 7)) {
      lines.push(`  ${bucket_start}: ${count}`)
    }
  }

  if (envelope.truncated) {
    lines.push('', '(window capped at 10k rows)')
  }

  return lines.join('\n')
}

// ── MCP tool handler ────────────────────────────────────────

export async function summarizeObservedQueries(input: SummarizeInput): Promise<{ content: [{ type: 'text'; text: string }]; isError?: boolean }> {
  try {
    // Parse and validate input
    const parsed = SummarizeInputSchema.parse(input)

    // Fetch rows from observed_queries (service_role access)
    let query = supabase
      .from('observed_queries')
      .select('source, question, caller_hint, user_agent, ip_hash, model, latency_ms, created_at')
      .order('created_at', { ascending: false })
      .limit(10000)

    // Apply filters in SQL for efficiency
    if (parsed.since) {
      query = query.gte('created_at', parsed.since)
    }
    if (parsed.until) {
      query = query.lte('created_at', parsed.until)
    }
    if (parsed.source) {
      query = query.eq('source', parsed.source)
    }
    if (parsed.caller_hint) {
      query = query.like('caller_hint', `${parsed.caller_hint}%`)
    }

    const { data: rows, error } = await query

    if (error) {
      return { content: [{ type: 'text', text: `Failed to fetch observed_queries: ${error.message}` }], isError: true }
    }

    if (!rows || rows.length === 0) {
      return { content: [{ type: 'text', text: 'No queries in this window.' }] }
    }

    // Aggregate
    const envelope = aggregateObservedQueries(rows as ObservedQuery[], parsed)

    // Check if no rows matched the window after aggregation
    if (envelope.totals.count === 0) {
      return { content: [{ type: 'text', text: 'No queries in this window.' }] }
    }

    // Return in requested format
    if (parsed.format === 'json') {
      return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] }
    }

    // Default: text format
    const text = formatEnvelopeToText(envelope)
    return { content: [{ type: 'text', text }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
}