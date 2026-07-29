/**
 * Unit tests for the public /observations surface.
 *
 *  - Pure helpers (privacy, shaping, topic scope, uuid guard) — no DB env needed.
 *  - One routing test for the `:id` uuid guard: a non-uuid id must 404 *before*
 *    any database call. Dummy SUPA_* env is set first so importing the supabase
 *    client doesn't throw (the 404 path never issues a query).
 *
 * Run: npm run test:unit
 */

// Set before any import that may pull in the supabase client. dotenv does not
// override already-set process.env keys, so this is honored locally and in CI.
process.env.SUPA_PROJECT_URL ??= 'http://localhost:54321'
process.env.SUPA_SERVICE_ROLE ??= 'test-dummy-key'

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import {
  isPublicThought,
  isAuthoredThought,
  shapeObservation,
  hasAnyTopic,
  parseAuthoredFilter,
  parseTopicScope,
  isUuid,
  AUTHORED_THOUGHT_SOURCES,
  DEFAULT_AUTHORED_FILTER,
  DEFAULT_OBSERVATION_TYPES,
} from '../src/lib/observations.js'

describe('observations helpers', () => {
  it('isPublicThought: only boolean true excludes; missing/false/null is public', () => {
    assert.equal(isPublicThought({ private: true }), false)
    assert.equal(isPublicThought({ private: false }), true)
    assert.equal(isPublicThought({}), true)
    assert.equal(isPublicThought(null), true)
    assert.equal(isPublicThought(undefined), true)
    // a truthy-but-not-boolean value must NOT be treated as the private flag
    assert.equal(isPublicThought({ private: 'true' }), true)
  })

  it('shapeObservation: maps a row to the public shape with a stable, normalized url', () => {
    const o = shapeObservation(
      {
        id: 'a431455d-eaed-4d74-91d3-4e098fa7fbd2',
        content: 'a dated premise',
        metadata: { type: 'observation', topics: ['OEP', 'employment'] },
        created_at: '2026-06-01T12:34:56.000Z',
      },
      'https://agent.example.com/', // trailing slash should be normalized away
    )
    assert.equal(o.id, 'a431455d-eaed-4d74-91d3-4e098fa7fbd2')
    assert.equal(o.date, '2026-06-01')
    assert.equal(o.captured_at, '2026-06-01T12:34:56.000Z')
    assert.equal(o.type, 'observation')
    assert.deepEqual(o.topics, ['OEP', 'employment'])
    assert.equal(o.content, 'a dated premise')
    assert.equal(o.url, 'https://agent.example.com/observations/a431455d-eaed-4d74-91d3-4e098fa7fbd2')
  })

  it('shapeObservation: carries the authored flag from metadata.source', () => {
    const row = (metadata: Record<string, unknown> | null) => ({
      id: 'a431455d-eaed-4d74-91d3-4e098fa7fbd2',
      content: 'c',
      metadata,
      created_at: '2026-06-01T00:00:00.000Z',
    })
    assert.equal(shapeObservation(row({ type: 'observation', source: 'mcp' }), 'https://h').authored, true)
    // the nightly sync's VERSION DRIFT warnings — type: observation, like an authored note
    assert.equal(
      shapeObservation(row({ type: 'observation', source: 'sync', topics: ['version_drift'] }), 'https://h').authored,
      false,
    )
    assert.equal(shapeObservation(row(null), 'https://h').authored, false)
  })

  it('shapeObservation: tolerates missing metadata', () => {
    const o = shapeObservation(
      { id: 'x', content: 'c', metadata: null, created_at: '2026-01-02T00:00:00.000Z' },
      'https://h',
    )
    assert.equal(o.type, null)
    assert.deepEqual(o.topics, [])
    assert.equal(o.date, '2026-01-02')
  })

  it('hasAnyTopic: case-insensitive match; empty scope matches everything', () => {
    assert.equal(hasAnyTopic({ topics: ['Open Employment Protocol'] }, ['open employment protocol']), true)
    assert.equal(hasAnyTopic({ topics: ['employment'] }, ['OEP']), false)
    assert.equal(hasAnyTopic({ topics: ['x'] }, []), true)
    assert.equal(hasAnyTopic(null, ['x']), false)
    assert.equal(hasAnyTopic(null, []), true)
  })

  it('parseTopicScope: splits on commas, trims, drops empties', () => {
    assert.deepEqual(
      parseTopicScope('OEP, Open Employment Protocol ,, employment'),
      ['OEP', 'Open Employment Protocol', 'employment'],
    )
    assert.deepEqual(parseTopicScope(undefined), [])
    assert.deepEqual(parseTopicScope(''), [])
  })

  it('isUuid: accepts a canonical uuid, rejects junk and traversal', () => {
    assert.equal(isUuid('a431455d-eaed-4d74-91d3-4e098fa7fbd2'), true)
    assert.equal(isUuid('not-a-uuid'), false)
    assert.equal(isUuid('../../etc/passwd'), false)
    assert.equal(isUuid(''), false)
  })

  it('isAuthoredThought: allowlist — only a known authored source counts', () => {
    assert.equal(isAuthoredThought({ source: 'mcp' }), true)
    // machine writers
    assert.equal(isAuthoredThought({ source: 'sync' }), false)
    assert.equal(isAuthoredThought({ source: 'enrichment' }), false)
    assert.equal(isAuthoredThought({ source: 'telemetry' }), false)
    // a source-less row is machine telemetry from a writer that predates the
    // convention — NOT an authored note (#222)
    assert.equal(isAuthoredThought({ type: 'observation' }), false)
    assert.equal(isAuthoredThought(null), false)
    assert.equal(isAuthoredThought(undefined), false)
    // non-string source must not be coerced into a match
    assert.equal(isAuthoredThought({ source: ['mcp'] }), false)
    // the point of the allowlist: a machine source nobody has heard of yet
    // stays out of the authored view instead of silently passing
    assert.equal(isAuthoredThought({ source: 'some-future-bot' }), false)
  })

  it('AUTHORED_THOUGHT_SOURCES: excludes every known machine writer', () => {
    const authored = AUTHORED_THOUGHT_SOURCES as readonly string[]
    assert.deepEqual([...authored], ['mcp'])
    for (const machine of ['sync', 'enrichment', 'telemetry']) {
      assert.equal(authored.includes(machine), false, `${machine} must not be an authored source`)
    }
  })

  it('parseAuthoredFilter: authored only, machine only, or all', () => {
    assert.equal(parseAuthoredFilter('1'), true)
    assert.equal(parseAuthoredFilter('true'), true)
    assert.equal(parseAuthoredFilter('YES'), true)
    assert.equal(parseAuthoredFilter(''), true) // bare ?authored reads as the flag
    assert.equal(parseAuthoredFilter('0'), false)
    assert.equal(parseAuthoredFilter('false'), false)
    assert.equal(parseAuthoredFilter('No'), false)
    // the pre-#222 mixed listing, now opt-in
    assert.equal(parseAuthoredFilter('all'), 'all')
    assert.equal(parseAuthoredFilter('ANY'), 'all')
    assert.equal(parseAuthoredFilter('both'), 'all')
  })

  it('parseAuthoredFilter: absent or junk falls back to the authored-only default', () => {
    // The crawler case: no query params at all must not serve telemetry.
    assert.equal(parseAuthoredFilter(undefined), DEFAULT_AUTHORED_FILTER)
    assert.equal(DEFAULT_AUTHORED_FILTER, true)
    // Junk falls back rather than being rejected, as with ?since / ?limit —
    // and the fallback direction is the safe one, not the mixed listing.
    assert.equal(parseAuthoredFilter('banana'), true)
  })

  it('DEFAULT_OBSERVATION_TYPES: the authored "why" layer, excluding the reference ledger', () => {
    // These are the types the bare /observations listing returns by default.
    assert.deepEqual([...DEFAULT_OBSERVATION_TYPES], ['observation', 'idea', 'task'])
    // The git-sync changelog ledger must NOT be in the default (reachable via ?type=reference).
    assert.equal((DEFAULT_OBSERVATION_TYPES as readonly string[]).includes('reference'), false)
  })
})

describe('GET /observations/:id guard (no DB call)', () => {
  let baseUrl: string
  let server: ReturnType<typeof serve>

  before(async () => {
    const { default: observationsRoute } = await import('../src/routes/observations.js')
    const app = new Hono()
    app.route('/observations', observationsRoute)
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://localhost:${info.port}`
        resolve()
      })
    })
  })

  after(() => server.close())

  it('returns 404 for a non-uuid id without touching the database', async () => {
    const res = await fetch(`${baseUrl}/observations/not-a-uuid`)
    assert.equal(res.status, 404)
    const body = (await res.json()) as { error: string }
    assert.equal(body.error, 'Not found')
  })
})
