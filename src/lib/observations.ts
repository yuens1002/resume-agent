/**
 * Pure helpers for the public `/observations` surface — the browsable
 * "reasoning/premise trail" behind the profile. Each public-eligible OB1
 * thought gets a stable, citable URL so a premise can be referenced as a
 * verifiable node (see the OEP `EVIDENCE-GRAPH.md` — "the edge-resolver made
 * browsable").
 *
 * Kept free of any I/O (no supabase import) so the privacy + shaping logic is
 * unit-testable without database env. The route (`src/routes/observations.ts`)
 * wires these to the `thoughts` table.
 */

export interface ThoughtRow {
  id: string
  content: string
  metadata: Record<string, unknown> | null
  created_at: string
}

export interface PublicObservation {
  id: string
  date: string // YYYY-MM-DD
  captured_at: string // full ISO timestamp
  type: string | null
  topics: string[]
  content: string
  url: string
}

/**
 * A thought reaches a public surface unless it is explicitly flagged
 * `metadata.private === true`. Mirrors the DB-layer rule in
 * `match_thoughts_public` (see `lib/thoughts-query.ts`): only the boolean `true`
 * excludes — a stray truthy string must not be mistaken for the private flag,
 * and a missing flag means public-eligible.
 */
export function isPublicThought(metadata: Record<string, unknown> | null | undefined): boolean {
  return (metadata?.private as unknown) !== true
}

/** Map a raw `thoughts` row to the public, citable observation shape. */
export function shapeObservation(row: ThoughtRow, baseUrl: string): PublicObservation {
  const m = row.metadata ?? {}
  const topics = Array.isArray(m.topics) ? (m.topics as unknown[]).map(String) : []
  return {
    id: row.id,
    date: row.created_at.slice(0, 10),
    captured_at: row.created_at,
    type: typeof m.type === 'string' ? m.type : null,
    topics,
    content: row.content,
    url: `${baseUrl.replace(/\/$/, '')}/observations/${row.id}`,
  }
}

/**
 * Case-insensitive topic membership. An empty `wanted` list means "no scope
 * restriction" → matches everything.
 */
export function hasAnyTopic(
  metadata: Record<string, unknown> | null | undefined,
  wanted: string[],
): boolean {
  if (!wanted.length) return true
  const set = new Set(wanted.map((t) => t.toLowerCase()))
  const topics = Array.isArray(metadata?.topics) ? (metadata!.topics as unknown[]) : []
  return topics.some((t) => set.has(String(t).toLowerCase()))
}

/** Parse the `OBSERVATIONS_TOPICS` env (comma-separated) into a clean list. */
export function parseTopicScope(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Guard `:id` before it reaches the database — reject anything non-canonical. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}
