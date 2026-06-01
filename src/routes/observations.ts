import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import {
  isPublicThought,
  shapeObservation,
  hasAnyTopic,
  parseTopicScope,
  isUuid,
  type ThoughtRow,
} from '../lib/observations.js'

const app = new Hono()

const baseUrlOf = (url: string): string =>
  (process.env.PUBLIC_URL ?? new URL(url).origin).replace(/\/$/, '')

// We exclude private thoughts and apply topic scope in app code, so over-fetch a
// bounded window of recent rows, then slice to the caller's limit.
const FETCH_CEILING = 300

/**
 * GET /observations — browsable list of public-eligible OB1 observations: the
 * dated reasoning/premise trail behind the profile. Private thoughts
 * (`metadata.private === true`) are always excluded. Each item carries a stable
 * URL so a premise can be cited as a verifiable node (OEP `EVIDENCE-GRAPH.md`).
 *
 * Query params:
 *   - `topic`  — filter by an exact OB1 topic tag
 *   - `type`   — filter by type (observation, idea, task, reference, …)
 *   - `since`  — only observations on/after this date (YYYY-MM-DD)
 *   - `limit`  — 1–100, default 25
 *
 * Without `topic`, the listing is scoped to `OBSERVATIONS_TOPICS` (comma-separated
 * env) when set; otherwise it returns the most recent public observations.
 */
app.get('/', async (c) => {
  const topic = c.req.query('topic')?.trim()
  const type = c.req.query('type')?.trim()
  const since = c.req.query('since')?.trim()
  const limitRaw = Number(c.req.query('limit'))
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100)
    : 25

  let q = supabase
    .from('thoughts')
    .select('id, content, metadata, created_at')
    .order('created_at', { ascending: false })
    .limit(FETCH_CEILING)

  if (type) q = q.contains('metadata', { type })
  if (topic) q = q.contains('metadata', { topics: [topic] })
  if (since) {
    const d = new Date(since)
    if (!Number.isNaN(d.getTime())) q = q.gte('created_at', d.toISOString())
  }

  const { data, error } = await q
  if (error) return c.json({ error: error.message }, 500)

  // When no explicit topic is requested, fall back to the owner-configured scope.
  const scope = topic ? [] : parseTopicScope(process.env.OBSERVATIONS_TOPICS)
  const baseUrl = baseUrlOf(c.req.url)

  const filtered = ((data ?? []) as ThoughtRow[])
    .filter((r) => isPublicThought(r.metadata))
    .filter((r) => (topic ? true : hasAnyTopic(r.metadata, scope)))
    .slice(0, limit)

  c.header('Cache-Control', 'public, max-age=300')
  return c.json({
    count: filtered.length,
    scope: topic ? { topic } : scope.length ? { topics: scope } : { recent: true },
    note: 'Public-eligible OB1 observations — the dated reasoning/premise trail behind this profile. Private thoughts are excluded; each item has a stable URL for citation. Context: OEP EVIDENCE-GRAPH.md.',
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

  if (error) return c.json({ error: error.message }, 500)

  const row = (data?.[0] ?? null) as ThoughtRow | null
  if (!row || !isPublicThought(row.metadata)) return c.json({ error: 'Not found' }, 404)

  c.header('Cache-Control', 'public, max-age=300')
  return c.json(shapeObservation(row, baseUrlOf(c.req.url)))
})

export default app
