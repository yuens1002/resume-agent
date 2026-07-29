/**
 * Privacy invariant for machine-written telemetry rows.
 *
 * `POST /resume` logs a rubric-failure thought when neither generation clears
 * the rubric, and that row embeds the first 200 characters of the submitted job
 * description. It was written with no `private` flag — and `isPublicThought`
 * treats a missing flag as public-eligible — so 100+ rows carrying real
 * employer JD text were readable at `GET /observations?topic=rubric` by anyone
 * who guessed the tag.
 *
 * These assertions exist so that regressing the flag fails a test instead of
 * silently republishing job descriptions. `isPublicThought` is the same
 * predicate the public surface uses, so this checks the actual consequence
 * rather than restating the literal.
 *
 * Run: npm run test:unit
 */

process.env.SUPA_PROJECT_URL ??= 'http://localhost:54321'
process.env.SUPA_SERVICE_ROLE ??= 'test-dummy-key'
process.env.OPENROUTER_API_KEY ??= 'test-dummy-key'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RUBRIC_FAILURE_METADATA } from '../src/routes/resume.js'
import { isPublicThought } from '../src/lib/observations.js'

describe('rubric-failure telemetry metadata', () => {
  it('is private — the row carries submitted job-description text', () => {
    assert.equal(RUBRIC_FAILURE_METADATA.private, true)
    // The consequence, not just the literal: the public surface must reject it.
    assert.equal(isPublicThought(RUBRIC_FAILURE_METADATA), false)
  })

  it('names its producer, so the authored/machine split is explicit', () => {
    // #222 (PR #225) classifies /observations items by metadata.source against
    // an allowlist of authored sources. An unstamped row already lands on the
    // machine side there, but naming the producer keeps the classification
    // explicit rather than resting on an absent field. Asserted as a literal
    // here because isAuthoredThought lands on that branch, not this one.
    assert.equal(RUBRIC_FAILURE_METADATA.source, 'telemetry')
  })

  it('keeps the topics the backfill and existing rows are selected by', () => {
    // scripts/backfill-private-telemetry.ts selects on 'resume-failure'; a
    // rename here would silently orphan future rows from that repair path.
    assert.deepEqual([...RUBRIC_FAILURE_METADATA.topics], ['resume-failure', 'rubric'])
  })
})
