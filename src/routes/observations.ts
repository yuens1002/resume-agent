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
// filter in memory.
//
// This ceiling was chosen to sit above the largest single thought type so a `?topic`
// filter would see *every* candidate of that type rather than only the most recent.
// That is no longer true and hasn't been for a while: the `reference` ledger is at
// 3,485 rows against this 1,000 ceiling, so `?type=reference&topic=…` already misses
// matches older than the window. Pre-existing and independent of the authored filter
// (#222) — the split runs over whatever this returns either way — but the guarantee
// this comment used to claim is gone, so it should not keep claiming it.
//
// Raising the number only moves the cliff and costs a bigger in-memory fetch on a
// public endpoint; the real fix is pushing topic matching into SQL alongside paging.
// The handler now logs when a request actually hits the ceiling, so the condition
// reports itself instead of depending on someone rereading this comment.
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
 * Additive: the default listing is unchanged and returns both classes; a
 * consumer opts in with `?authored=`.
 *
 * Query params:
 *   - `topic`    — filter by an OB1 topic tag (case-insensitive)
 *   - `type`     — override the type filter (e.g. `reference` for the changelog ledger)
 *   - `since`    — only observations on/after this date (YYYY-MM-DD)
 *   - `authored` — `1` authored notes only, `0` machine entries only; omitted
 *                  returns both (the default is unchanged)
 *   - `limit`    — 1–500, default 25
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
  // Ceiling raised 100 → 500 (#222 follow-on): the consumer is a server-rendered,
  // sitemap-listed page that wants every authored note in one request, and there
  // is no browsing UI to paginate. Costs nothing at the DB layer — the query
  // already fetches up to FETCH_CEILING rows and this only widens the in-memory
  // slice taken from them. Revisit if authored notes approach FETCH_CEILING.
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500)
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
  //
  // Bounded, like the topic filter above, by the FETCH_CEILING window: the
  // filter runs over the most recent FETCH_CEILING rows of the requested
  // type(s), not the whole table. A full page is therefore guaranteed only
  // while `limit` matching rows exist inside that window — true by a wide
  // margin today (174 authored rows against a 1000-row ceiling), but the
  // filter would need to move into SQL alongside real paging before this
  // endpoint could promise it unconditionally.
  const rows = (data ?? []) as ThoughtRow[]

  // The fetch window is the one bound this endpoint can't express in its
  // response, so make it say something when it's reached rather than relying on
  // someone remembering the comment above. A full window means the filters ran
  // over a truncated set and `total` below is itself a floor, not a count.
  if (rows.length >= FETCH_CEILING) {
    console.warn(
      `[observations] fetch hit FETCH_CEILING (${FETCH_CEILING}) for type=${type ?? 'default'} — ` +
      'filters ran over a truncated window; move filtering into SQL with paging.',
    )
  }

  const matched = rows
    .filter((r) => isPublicThought(r.metadata))
    .filter((r) => hasAnyTopic(r.metadata, wantedTopics))
    .filter((r) => authored === undefined || isAuthoredThought(r.metadata) === authored)
  const filtered = matched.slice(0, limit)

  c.header('Cache-Control', 'public, max-age=300')
  return c.json({
    count: filtered.length,
    // What matched vs what was returned. `count` alone can't tell a consumer
    // whether it saw everything or hit the limit — it silently comes up short.
    // `total` is bounded by the FETCH_CEILING window (see above), so it is a
    // floor rather than a table-wide count; `truncated` is exact.
    total: matched.length,
    truncated: matched.length > filtered.length,
    scope: topic ? { topic } : envScope.length ? { topics: envScope } : { recent: true },
    types: type ? [type] : [...DEFAULT_OBSERVATION_TYPES],
    // Echoed only when the filter was actually requested, so the default
    // response shape is unchanged for existing consumers. Doubles as a
    // capability probe on exactly the call a filtering client makes: `?authored=1`
    // against a deployment predating #222 silently returns the unfiltered list
    // with a 200 and plausible JSON, and the absence of this key is the only
    // way to tell that apart from a filter that was honored.
    ...(authored === undefined ? {} : { authored }),
    note: 'Public-eligible OB1 observations — the dated, authored reasoning trail (the "why"). Each item carries `authored`: true for a hand-written note, false for a machine-generated sync/telemetry entry (e.g. VERSION DRIFT warnings); filter server-side with ?authored=1 or ?authored=0. Excludes the git-sync changelog ledger by default; pass ?type=reference for that. `total` and `truncated` report what matched vs what this page returned. Private thoughts are excluded; each item has a stable URL for citation. See README "GET /observations" and OEP EVIDENCE-GRAPH.md.',
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
