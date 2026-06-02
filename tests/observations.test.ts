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
  shapeObservation,
  hasAnyTopic,
  parseTopicScope,
  isUuid,
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

  it('DEFAULT_OBSERVATION_TYPES: the authored "why" layer, excluding the reference ledger', () => {
    // These are the types the bare /observations listing returns by default.
    assert.deepEqual([...DEFAULT_OBSERVATION_TYPES], ['observation', 'idea', 'task'])
    // The git-sync changelog ledger must NOT be in the default (reachable via ?type=reference).
    assert.equal(DEFAULT_OBSERVATION_TYPES.includes('reference' as never), false)
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
