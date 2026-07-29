/**
 * Composition tests for the `GET /observations` listing.
 *
 * These exist because of a specific failure. The authored filter (#222) once
 * emptied `?type=reference` — every ledger row is machine-written, so an
 * authored-only default matched none of them — and **498 unit tests stayed
 * green** through it. Every predicate was individually correct; the bug lived
 * entirely in how they were wired together, which nothing observed. The route
 * imports `supabase` at module load, so route-level behaviour had no coverage
 * at all and was verified only by live requests against production.
 *
 * `buildObservationsListing` is that wiring, extracted so it can be driven with
 * fixture rows and no database. What is asserted here is the composition:
 * filter precedence, the pre-limit slice, the envelope's derived fields, and
 * the presence/absence of the `authored` echo.
 *
 * No DB, no env, no network — pure function in, envelope out.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildObservationsListing,
  parseAuthoredFilter,
  DEFAULT_OBSERVATION_TYPES,
  type ThoughtRow,
} from '../src/lib/observations.js'

// ── Fixtures ────────────────────────────────────────────────
// Deliberately mirrors the real table's shape: authored notes carry
// `source: 'mcp'`, sync warnings carry `source: 'sync'`, the changelog ledger
// carries `source: 'enrichment'`, and the pre-convention telemetry carries no
// `source` at all.

let seq = 0
const row = (
  metadata: Record<string, unknown> | null,
  content = 'body',
): ThoughtRow => ({
  id: `0000000${(seq += 1).toString().padStart(1, '0')}-eaed-4d74-91d3-4e098fa7fbd2`,
  content,
  metadata,
  created_at: '2026-06-01T00:00:00.000Z',
})

const authoredNote = (topics: string[] = ['resume-agent']) =>
  row({ type: 'observation', source: 'mcp', topics })
const syncWarning = (topics: string[] = ['resume-agent', 'version_drift']) =>
  row({ type: 'observation', source: 'sync', topics }, 'VERSION DRIFT [resume-agent]: …')
const ledgerRow = (topics: string[] = ['resume-agent']) =>
  row({ type: 'reference', source: 'enrichment', topics })
const unsourcedTelemetry = (topics: string[] = ['resume-failure', 'rubric']) =>
  row({ type: 'observation', topics }, 'RESUME_RUBRIC_FAILURE: …')
const privateNote = (topics: string[] = ['resume-agent']) =>
  row({ type: 'observation', source: 'mcp', private: true, topics })

const base = { envScope: [], limit: 25, baseUrl: 'https://agent.example.com' }

describe('buildObservationsListing — filter precedence', () => {
  it('excludes private rows regardless of any other filter', () => {
    // Privacy is not one filter among several — it must hold even when the
    // caller explicitly asks for the class the private row belongs to.
    const rows = [authoredNote(), privateNote(), privateNote()]
    for (const authored of [undefined, true, false] as const) {
      const out = buildObservationsListing(rows, { ...base, authored })
      assert.equal(
        out.observations.every((o) => o.id !== rows[1].id && o.id !== rows[2].id),
        true,
        `private row leaked with authored=${String(authored)}`,
      )
    }
  })

  it('no ?authored means no authored filtering — both classes come back', () => {
    // THE REGRESSION TEST. An authored-only default emptied ?type=reference,
    // because every ledger row is machine-written. With no filter applied by
    // default, machine rows survive by construction.
    const rows = [authoredNote(), syncWarning(), ledgerRow(), unsourcedTelemetry()]
    const out = buildObservationsListing(rows, { ...base, authored: undefined })
    assert.equal(out.count, 4)
    assert.equal(out.observations.filter((o) => o.authored).length, 1)
    assert.equal(out.observations.filter((o) => !o.authored).length, 3)
  })

  it('a ledger-only page survives with no ?authored — the ?type=reference hatch', () => {
    // The exact shape the DB returns for ?type=reference: every row machine-
    // written. This must not come back empty.
    const rows = [ledgerRow(), ledgerRow(), ledgerRow()]
    const out = buildObservationsListing(rows, { ...base, type: 'reference' })
    assert.equal(out.count, 3, 'ledger rows must survive the default listing')
    assert.equal(out.total, 3)
    assert.deepEqual(out.types, ['reference'])
  })

  it('?authored=1 keeps only authored; ?authored=0 keeps only machine', () => {
    const rows = [authoredNote(), syncWarning(), ledgerRow(), unsourcedTelemetry()]
    const yes = buildObservationsListing(rows, { ...base, authored: true })
    assert.equal(yes.count, 1)
    assert.equal(yes.observations.every((o) => o.authored), true)

    const no = buildObservationsListing(rows, { ...base, authored: false })
    assert.equal(no.count, 3)
    assert.equal(no.observations.every((o) => !o.authored), true)
  })

  it('topic scope and the authored filter compose (both applied, not either)', () => {
    const rows = [
      authoredNote(['OEP']),
      authoredNote(['resume-agent']),
      syncWarning(['OEP']),
    ]
    const out = buildObservationsListing(rows, { ...base, topic: 'oep', authored: true })
    assert.equal(out.count, 1, 'only the authored row tagged OEP')
    assert.equal(out.observations[0].topics[0], 'OEP')
  })

  it('an explicit ?topic overrides the env scope rather than intersecting it', () => {
    const rows = [authoredNote(['OEP']), authoredNote(['resume-agent'])]
    const out = buildObservationsListing(rows, {
      ...base,
      envScope: ['resume-agent'],
      topic: 'OEP',
    })
    assert.equal(out.count, 1)
    assert.equal(out.observations[0].topics[0], 'OEP')
  })
})

describe('the ?type=reference regression, end to end', () => {
  it('an unset ?authored param, parsed and applied, leaves the ledger intact', () => {
    // The full path the regression took, minus HTTP: a request with no
    // ?authored arrives, the raw query value is `undefined`, that goes through
    // parseAuthoredFilter, and the result is applied to ledger rows.
    //
    // Chained deliberately rather than passing `authored: undefined` directly.
    // The bug was a change to what an ABSENT param resolves to; a test that
    // hardcodes the post-parse value can't see it. Both halves have to be in
    // the same test for it to fail the way the endpoint failed.
    const rawQueryValue = undefined // no ?authored in the query string
    const authored = parseAuthoredFilter(rawQueryValue)

    const ledger = [ledgerRow(), ledgerRow(), ledgerRow(), ledgerRow(), ledgerRow()]
    const out = buildObservationsListing(ledger, { ...base, type: 'reference', authored })

    assert.equal(
      out.count,
      5,
      'GET /observations?type=reference returned nothing — the documented escape hatch is empty ' +
      'while the response note still advertises it',
    )
  })

  it('the same holds for the other machine-written types', () => {
    // review_needed and notification are sync-written too; the regression
    // emptied them identically, and neither was noticed at the time.
    for (const type of ['review_needed', 'notification']) {
      const rows = [row({ type, source: 'sync', topics: ['employment'] })]
      const out = buildObservationsListing(rows, {
        ...base,
        type,
        authored: parseAuthoredFilter(undefined),
      })
      assert.equal(out.count, 1, `?type=${type} returned nothing`)
    }
  })
})

describe('buildObservationsListing — limit is applied after filtering', () => {
  it('returns a full page of matches, not the matches left in a page', () => {
    // 3 authored notes buried under 10 machine rows. Slicing first would
    // return 2 of 5; filtering first returns all 3.
    const rows = [
      ...Array.from({ length: 10 }, () => syncWarning()),
      authoredNote(),
      authoredNote(),
      authoredNote(),
    ]
    const out = buildObservationsListing(rows, { ...base, authored: true, limit: 5 })
    assert.equal(out.count, 3)
    assert.equal(out.total, 3)
    assert.equal(out.truncated, false)
  })

  it('truncated is true exactly when limit cut the match set short', () => {
    const rows = Array.from({ length: 7 }, () => authoredNote())

    const cut = buildObservationsListing(rows, { ...base, limit: 3 })
    assert.equal(cut.count, 3)
    assert.equal(cut.total, 7, 'total reports matches, not the page')
    assert.equal(cut.truncated, true)

    const whole = buildObservationsListing(rows, { ...base, limit: 25 })
    assert.equal(whole.count, 7)
    assert.equal(whole.total, 7)
    assert.equal(whole.truncated, false)

    const exact = buildObservationsListing(rows, { ...base, limit: 7 })
    assert.equal(exact.truncated, false, 'limit == total is not truncated')
  })

  it('total counts matches after filtering, not raw rows', () => {
    const rows = [authoredNote(), syncWarning(), privateNote()]
    const out = buildObservationsListing(rows, { ...base, authored: true })
    assert.equal(out.total, 1, 'not 3 — private and machine rows are not matches')
  })
})

describe('buildObservationsListing — envelope', () => {
  it('omits the authored key when no filter was requested, includes it when one was', () => {
    // The capability probe: key-absence is how a client distinguishes "filter
    // honored" from "unknown param silently ignored" on a 200 with plausible JSON.
    const rows = [authoredNote()]
    assert.equal('authored' in buildObservationsListing(rows, { ...base }), false)
    assert.equal(buildObservationsListing(rows, { ...base, authored: true }).authored, true)
    assert.equal(buildObservationsListing(rows, { ...base, authored: false }).authored, false)
  })

  it('reports scope as topic, topics, or recent', () => {
    const rows = [authoredNote()]
    assert.deepEqual(buildObservationsListing(rows, { ...base, topic: 'OEP' }).scope, { topic: 'OEP' })
    assert.deepEqual(
      buildObservationsListing(rows, { ...base, envScope: ['a', 'b'] }).scope,
      { topics: ['a', 'b'] },
    )
    assert.deepEqual(buildObservationsListing(rows, { ...base }).scope, { recent: true })
  })

  it('echoes the explicit type, or the default type set', () => {
    const rows = [authoredNote()]
    assert.deepEqual(buildObservationsListing(rows, { ...base, type: 'reference' }).types, ['reference'])
    assert.deepEqual(
      buildObservationsListing(rows, { ...base }).types,
      [...DEFAULT_OBSERVATION_TYPES],
    )
  })

  it('shapes each item with a stable citation URL and the authored flag', () => {
    const out = buildObservationsListing([authoredNote(), syncWarning()], { ...base })
    assert.equal(out.observations[0].url, `${base.baseUrl}/observations/${out.observations[0].id}`)
    assert.equal(out.observations[0].authored, true)
    assert.equal(out.observations[1].authored, false)
  })

  it('handles an empty result without inventing fields', () => {
    const out = buildObservationsListing([], { ...base, authored: true })
    assert.equal(out.count, 0)
    assert.equal(out.total, 0)
    assert.equal(out.truncated, false)
    assert.deepEqual(out.observations, [])
  })
})
