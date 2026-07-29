import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import {
  isPublicThought,
  isAuthoredThought,
  shapeObservation,
  hasAnyTopic,
  parseAuthoredFilter,
  parseTopicScope,
  isUuid,
  DEFAULT_OBSERVATION_TYPES,
  type ThoughtRow,
} from '../lib/observations.js'

const app = new Hono()

const baseUrlOf = (url: string): string =>
  (process.env.PUBLIC_URL ?? new URL(url).origin).replace(/\/$/, '')

// Topic is matched in app code (case-insensitive), so we fetch the per-type window and
// filter in memory. The ceiling sits above the largest single thought type (the
// `reference` ledger) so a `?topic` filter sees *every* candidate of that type, not just
// the most recent — otherwise `?type=reference&topic=…` could miss matches outside the
// window. Revisit if any one type ever grows past this.
const FETCH_CEILING = 1000

/**
 * GET /observations — browsable list of public-eligible OB1 observations: the
 * dated reasoning/premise trail behind the profile. Private thoughts
 * (`metadata.private === true`) are always excluded. Each item carries a stable
 * URL so a premise can be cited as a verifiable node (OEP `EVIDENCE-GRAPH.md`).
 *
 * Defaults to the *authored* reasoning layer ({@link DEFAULT_OBSERVATION_TYPES} —
 * observation/idea/task: the "why & lessons"), and excludes the git-sync `reference`
 * ledger ("what shipped"). The ledger still grounds `/query` and `/resume`; fetch it
 * here explicitly with `?type=reference`.
 *
 * Every item carries `authored` (#222): true for a hand-written note, false for
 * a machine-generated sync/telemetry entry — the two classes the endpoint's own
 * `note` distinguishes but that `?type=` could not separate, since the nightly
 * sync's VERSION DRIFT warnings are `type: "observation"` like everything else.
 *
 * Query params:
 *   - `topic`    — filter by an OB1 topic tag (case-insensitive)
 *   - `type`     — override the type filter (e.g. `reference` for the changelog ledger)
 *   - `since`    — only observations on/after this date (YYYY-MM-DD)
 *   - `authored` — `1` for authored notes only, `0` for machine entries only;
 *                  omitted returns both (the default is unchanged, additive)
 *   - `limit`    — 1–100, default 25
 *
 * Without `topic`, the listing is scoped to `OBSERVATIONS_TOPICS` (comma-separated
 * env, case-insensitive) when set; otherwise it returns the most recent public
 * observations.
 */
app.get('/', async (c) => {
  const topic = c.req.query('topic')?.trim()
  const type = c.req.query('type')?.trim()
  const since = c.req.query('since')?.trim()
  const authored = parseAuthoredFilter(c.req.query('authored'))
  const limitRaw = Number(c.req.query('limit'))
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100)
    : 25

  // Type filter is applied at the DB layer (before LIMIT) so a small, older type isn't
  // crowded out of the window by a large, freshly-synced one. With FETCH_CEILING above
  // the largest type's row count, the in-memory topic filter sees the complete per-type
  // set, so case-insensitive `?topic` matching is exact, not recency-bounded.
  let q = supabase
    .from('thoughts')
    .select('id, content, metadata, created_at')
    .order('created_at', { ascending: false })
    .limit(FETCH_CEILING)

  if (type) q = q.contains('metadata', { type })
  else q = q.in('metadata->>type', [...DEFAULT_OBSERVATION_TYPES])
  if (since) {
    const d = new Date(since)
    if (!Number.isNaN(d.getTime())) q = q.gte('created_at', d.toISOString())
  }

  const { data, error } = await q
  if (error) {
    // Never echo error.message to the public: upstream failures can carry
    // whole HTML error pages (observed: a Cloudflare error page during the
    // 2026-07-24 Supabase outage). Log it (bounded), return a generic body.
    console.error(`[observations] list fetch failed: ${error.message.slice(0, 300)}`)
    return c.json({ error: 'Failed to load observations — retry shortly' }, 503)
  }

  // Topic scope: an explicit `?topic` (single tag) overrides the owner-configured
  // default scope. Matching is case-insensitive (see hasAnyTopic) so casing variants
  // of the same tag — e.g. "open employment protocol" vs "Open Employment Protocol" —
  // resolve to one trail.
  const envScope = parseTopicScope(process.env.OBSERVATIONS_TOPICS)
  const wantedTopics = topic ? [topic] : envScope
  const baseUrl = baseUrlOf(c.req.url)

  // The authored/machine split is applied BEFORE the limit slice, so
  // `?authored=1&limit=25` returns 25 authored notes rather than whatever
  // survives filtering a mixed page of 25 — the reason this is a server-side
  // param and not just a per-item field (#222).
  const filtered = ((data ?? []) as ThoughtRow[])
    .filter((r) => isPublicThought(r.metadata))
    .filter((r) => hasAnyTopic(r.metadata, wantedTopics))
    .filter((r) => authored === undefined || isAuthoredThought(r.metadata) === authored)
    .slice(0, limit)

  c.header('Cache-Control', 'public, max-age=300')
  return c.json({
    count: filtered.length,
    scope: topic ? { topic } : envScope.length ? { topics: envScope } : { recent: true },
    types: type ? [type] : [...DEFAULT_OBSERVATION_TYPES],
    // Echoed only when the filter was actually requested, so the default
    // response shape is unchanged for existing consumers.
    ...(authored === undefined ? {} : { authored }),
    note: 'Public-eligible OB1 observations — the dated, authored reasoning trail (the "why"). Each item carries `authored`: true for a hand-written note, false for a machine-generated sync/telemetry entry (e.g. VERSION DRIFT warnings); filter server-side with ?authored=1 or ?authored=0. Excludes the git-sync changelog ledger by default; pass ?type=reference for that. Private thoughts are excluded; each item has a stable URL for citation. See README "GET /observations" and OEP EVIDENCE-GRAPH.md.',
    observations: filtered.map((r) => shapeObservation(r, baseUrl)),
  })
})

/**
 * GET /observations/:id — a single public-eligible observation by stable id.
 * Returns 404 (never 403) for a private or missing thought, so the endpoint
 * never confirms the existence of a private thought.
 */
app.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Not found' }, 404)

  const { data, error } = await supabase
    .from('thoughts')
    .select('id, content, metadata, created_at')
    .eq('id', id)
    .limit(1)

  if (error) {
    console.error(`[observations] detail fetch failed: ${error.message.slice(0, 300)}`)
    return c.json({ error: 'Failed to load observation — retry shortly' }, 503)
  }

  const row = (data?.[0] ?? null) as ThoughtRow | null
  if (!row || !isPublicThought(row.metadata)) return c.json({ error: 'Not found' }, 404)

  c.header('Cache-Control', 'public, max-age=300')
  return c.json(shapeObservation(row, baseUrlOf(c.req.url)))
})

export default app
