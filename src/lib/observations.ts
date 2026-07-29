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

/**
 * The thought types `/observations` returns by default — the *authored* reasoning
 * layer (the "why / lessons / aha"). This deliberately EXCLUDES `type: reference`,
 * which is the git-to-OB1 sync's commit/changelog ledger (the "what shipped"): that
 * ledger still grounds `/query` and `/resume` semantically and is reachable here via
 * an explicit `?type=reference`, but it does not belong in the default reflective
 * view. See README "GET /observations" for the observations-vs-verify distinction.
 */
export const DEFAULT_OBSERVATION_TYPES = ['observation', 'idea', 'task'] as const

/**
 * `metadata.source` values that mean *a human wrote this note by hand*. Today
 * that is exactly the private MCP `capture_thought` path (`src/routes/mcp.ts`
 * stamps `source: 'mcp'`); the nightly git sync stamps `'sync'`/`'enrichment'`.
 *
 * Deliberately an ALLOWLIST of authored sources rather than a denylist of
 * machine ones. A denylist has the same failure mode as the consumer-side topic
 * heuristic this signal replaces (#222): the day a new machine writer appears,
 * its rows silently pass as authored. With an allowlist a new producer is
 * `authored: false` until it is explicitly added here — the fail-closed
 * direction for a crawlable surface.
 *
 * A *missing* `source` is therefore not authored, which also matches the data:
 * every source-less public thought in the live table is machine telemetry from
 * writers that predate the convention (`RESUME_RUBRIC_FAILURE` rows, duplicate
 * job-application logs), not a hand-written note.
 */
export const AUTHORED_THOUGHT_SOURCES = ['mcp'] as const

/**
 * Whether a thought is an authored note (the reasoning trail) as opposed to a
 * machine-generated sync/telemetry entry. See {@link AUTHORED_THOUGHT_SOURCES}
 * for why this is an allowlist.
 */
export function isAuthoredThought(metadata: Record<string, unknown> | null | undefined): boolean {
  const source = metadata?.source
  return typeof source === 'string' && (AUTHORED_THOUGHT_SOURCES as readonly string[]).includes(source)
}

/**
 * Parse the `?authored=` query param into a tri-state filter: `true` (authored
 * notes only), `false` (machine entries only), or `undefined` (**no filter** —
 * the default, so the listing stays backward-compatible).
 *
 * Additive by design: the default listing returns both classes exactly as it
 * always has, and a consumer opts in to filtering. The indexed surface is the
 * server-rendered page on the frontend, which passes `?authored=1` — the API
 * itself is a data source, not the thing in the sitemap, so the default here
 * doesn't need to change to keep thin content out of search results.
 *
 * A bare `?authored` with no value reads as `true` — the usual flag convention.
 * An unrecognized value is ignored rather than rejected, matching how `?since`
 * and `?limit` already treat junk on this surface.
 */
export function parseAuthoredFilter(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (v === '' || v === '1' || v === 'true' || v === 'yes') return true
  if (v === '0' || v === 'false' || v === 'no') return false
  return undefined
}

export interface PublicObservation {
  id: string
  date: string // YYYY-MM-DD
  captured_at: string // full ISO timestamp
  type: string | null
  topics: string[]
  content: string
  url: string
  /**
   * True for a hand-authored note, false for a machine-generated sync/telemetry
   * entry (e.g. the nightly sync's VERSION DRIFT warnings). Lets a consumer
   * separate the two classes without guessing from topics or content length.
   */
  authored: boolean
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
    authored: isAuthoredThought(m),
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

/** Everything the listing composition needs, independent of Hono or Supabase. */
export interface ListingParams {
  /** Explicit `?topic`; overrides `envScope` when present. */
  topic?: string
  /** `OBSERVATIONS_TOPICS`, already parsed by {@link parseTopicScope}. */
  envScope: string[]
  /** Explicit `?type`, for the `types` echo. Row-level type filtering is the DB's job. */
  type?: string
  /** Resolved `?authored` — `undefined` means no filter. */
  authored?: boolean
  /** Clamped `?limit`. */
  limit: number
  /** Base URL for each observation's stable citation link. */
  baseUrl: string
}

/** The `GET /observations` response envelope. */
export interface ListingResult {
  count: number
  total: number
  truncated: boolean
  scope: { topic: string } | { topics: string[] } | { recent: true }
  types: string[]
  authored?: boolean
  observations: PublicObservation[]
}

/**
 * Compose the `/observations` listing from already-fetched rows.
 *
 * Extracted from the route so the *composition* is testable, not just the
 * individual predicates. That distinction is not academic: the authored filter
 * once emptied `?type=reference` — every ledger row is machine-written, so an
 * authored-only default matched none of them — while 498 unit tests stayed
 * green, because every helper behaved correctly in isolation and no test
 * exercised them together. The bug lived entirely here, in the wiring.
 *
 * Order matters and is asserted by the tests: privacy first (a private row must
 * never reach a public surface regardless of any other filter), then topic
 * scope, then the authored split, and only then the `limit` slice — so a full
 * page is a page of matches rather than the matches remaining in a page.
 *
 * Bounded by whatever window the caller fetched: `total` counts matches among
 * `rows`, so it is a floor when the fetch was itself truncated. The route logs
 * when that happens.
 */
export function buildObservationsListing(
  rows: ThoughtRow[],
  params: ListingParams,
): ListingResult {
  const { topic, envScope, type, authored, limit, baseUrl } = params
  const wantedTopics = topic ? [topic] : envScope

  const matched = rows
    .filter((r) => isPublicThought(r.metadata))
    .filter((r) => hasAnyTopic(r.metadata, wantedTopics))
    .filter((r) => authored === undefined || isAuthoredThought(r.metadata) === authored)
  const page = matched.slice(0, limit)

  return {
    count: page.length,
    total: matched.length,
    truncated: matched.length > page.length,
    scope: topic ? { topic } : envScope.length ? { topics: envScope } : { recent: true },
    types: type ? [type] : [...DEFAULT_OBSERVATION_TYPES],
    // Present only when the filter was requested — the absence of this key is
    // how a client detects a deployment that silently ignored `?authored`.
    ...(authored === undefined ? {} : { authored }),
    observations: page.map((r) => shapeObservation(r, baseUrl)),
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Guard `:id` before it reaches the database — reject anything non-canonical. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}
