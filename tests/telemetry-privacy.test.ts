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
 * `src/routes/resume.ts` reaches the supabase and model clients at module load
 * and both throw on missing env, so the dummy values below have to be in place
 * *before* it is evaluated. ESM hoists static imports above the module body, so
 * a top-level `import` of the route would load it before these assignments ever
 * run — passing locally, where dotenv finds a real `.env.local`, and failing in
 * CI, where it does not. Hence the dynamic import inside `before`, the same
 * pattern tests/observations.test.ts and tests/get-descriptors.test.ts use.
 *
 * Run: npm run test:unit
 */

process.env.SUPA_PROJECT_URL ??= 'http://localhost:54321'
process.env.SUPA_SERVICE_ROLE ??= 'test-dummy-key'
process.env.OPENROUTER_API_KEY ??= 'test-dummy-key'

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { isPublicThought, isAuthoredThought } from '../src/lib/observations.js'

let RUBRIC_FAILURE_METADATA: Readonly<{
  type: string
  source: string
  private: boolean
  topics: readonly string[]
}>
let TARGETS: ReadonlyArray<{ topic: string; source: string; contentPattern: RegExp }>

before(async () => {
  // Both dynamic, for the same reason: each module reaches the supabase client
  // at load. The backfill script additionally guards its `main()` behind an
  // is-main check so importing it here reads TARGETS without running a backfill.
  ;({ RUBRIC_FAILURE_METADATA } = await import('../src/routes/resume.js'))
  ;({ TARGETS } = await import('../scripts/backfill-private-telemetry.js'))
})

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

  it('is selectable by the backfill script — asserted against its actual selectors', () => {
    // The relation, not a literal on each side. Previously this pinned
    // ['resume-failure', 'rubric'] here while the script pinned
    // topic: 'resume-failure' there, with only a comment claiming they must
    // agree — so renaming the topic and updating this literal would have left
    // the script silently matching nothing. Now the two are compared.
    const selectors = TARGETS.map((t) => t.topic)
    const covered = RUBRIC_FAILURE_METADATA.topics.filter((t) => selectors.includes(t))
    assert.ok(
      covered.length > 0,
      `no backfill selector (${selectors.join(', ')}) matches the producer's topics ` +
      `(${RUBRIC_FAILURE_METADATA.topics.join(', ')}) — the repair path would match nothing`,
    )
  })

  it('is frozen through the nested topics array, not just at the top level', () => {
    // Object.freeze is shallow. Without freezing topics too, a stray push()
    // would mutate the shared constant every subsequent write reads from.
    assert.equal(Object.isFrozen(RUBRIC_FAILURE_METADATA), true)
    assert.equal(Object.isFrozen(RUBRIC_FAILURE_METADATA.topics), true)
    assert.throws(
      () => (RUBRIC_FAILURE_METADATA.topics as string[]).push('injected'),
      TypeError,
    )
  })
})

describe('backfill source repair — never labels a machine row as authored', () => {
  it('every target source is outside the authored allowlist', () => {
    // The repair pass rewrites metadata.source. If any target named an
    // authored source it would re-create the exact misclassification it
    // exists to undo — 122 machine rows had acquired source: 'mcp' from
    // update_thought's old fallback.
    for (const t of TARGETS) {
      assert.equal(
        isAuthoredThought({ source: t.source }),
        false,
        `target source "${t.source}" must not classify as authored`,
      )
    }
  })

  it('the rubric target matches what the producer actually writes', () => {
    const rubric = TARGETS.find((t) => t.topic === 'resume-failure')
    assert.ok(rubric, 'rubric target present')
    // Both halves of the pair, compared rather than pinned twice.
    assert.equal(rubric.source, RUBRIC_FAILURE_METADATA.source)
    assert.ok(
      rubric.contentPattern.test('RESUME_RUBRIC_FAILURE: best_score=3.9/4 | JD: …'),
      'content signature matches the producer output shape',
    )
    assert.equal(
      rubric.contentPattern.test('A hand-written note about resume failures'),
      false,
      'signature must not match an authored note carrying the same topic',
    )
  })
})
