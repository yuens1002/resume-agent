import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { candidateNameForms, installOutputRedaction, redactableForms, redactCandidateNameToRole } from '../scripts/eval/redact-candidate-name.js'

const FORMS = candidateNameForms('Jamie Doe')

// ── candidateNameForms ───────────────────────────────────────

test('candidateNameForms: full name first, then each word', () => {
  assert.deepEqual(FORMS, ['Jamie Doe', 'Jamie', 'Doe'])
})

test('candidateNameForms: sorts longest first regardless of argument order', () => {
  assert.deepEqual(candidateNameForms('Jamie', 'Jamie Doe'), ['Jamie Doe', 'Jamie', 'Doe'])
  // Without the sort, "Jamie" would run first and leave "the candidate Doe".
  assert.equal(redactCandidateNameToRole('Jamie Doe built X', candidateNameForms('Jamie', 'Jamie Doe')), 'The candidate built X')
})

test('candidateNameForms: collapses whitespace in the source name', () => {
  assert.deepEqual(candidateNameForms('  Jamie   Doe '), ['Jamie Doe', 'Jamie', 'Doe'])
})

test('candidateNameForms: ignores empty and whitespace-only names', () => {
  assert.deepEqual(candidateNameForms('', '  '), [])
})

test('candidateNameForms: skips one-letter initials, adds first+last for 3+ words', () => {
  assert.deepEqual(candidateNameForms('Jamie Q. Doe'), ['Jamie Q. Doe', 'Jamie Doe', 'Jamie', 'Doe'])
  assert.equal(
    redactCandidateNameToRole('  A: Jamie Doe cites a source.', candidateNameForms('Jamie A Doe')),
    '  A: The candidate cites a source.',
  )
})

test('redactCandidateNameToRole: two-letter name words redact case-sensitively only', () => {
  const forms = candidateNameForms('Bo Li')
  assert.deepEqual(forms, ['Bo Li', 'Bo', 'Li'])
  assert.equal(
    redactCandidateNameToRole('Li shipped it; the li element and bo staff stay.', forms),
    'The candidate shipped it; the li element and bo staff stay.',
  )
})

test('redactCandidateNameToRole: a form never re-matches inside an inserted "the candidate"', () => {
  // Sequential per-form passes (longest first) would turn "Maximilian built"
  // into "The candidate built", then redact its "candidate" again via the
  // shorter surname form — and "Jamie" into "the candidate", then its "the".
  assert.equal(
    redactCandidateNameToRole('Maximilian built it; Candidate agreed.', candidateNameForms('Maximilian Candidate')),
    'The candidate built it; the candidate agreed.',
  )
  assert.equal(
    redactCandidateNameToRole('Ask Jamie about it.', candidateNameForms('Jamie The')),
    'Ask the candidate about it.',
  )
})

test('candidateNameForms: splits hyphenated names into their parts', () => {
  assert.deepEqual(candidateNameForms('Mary-Kate Doe'), ['Mary-Kate Doe', 'Mary-Kate', 'Mary', 'Kate', 'Doe'])
})

test('redactableForms: empty for a one-letter-only name, so run-eval refuses to run', () => {
  assert.deepEqual(redactableForms(candidateNameForms('A')), [])
  assert.deepEqual(redactableForms(candidateNameForms('')), [])
  assert.deepEqual(redactableForms(['Jamie', 'J', 'Jamie Doe']), ['Jamie Doe', 'Jamie'])
})

// ── redactCandidateNameToRole ────────────────────────────────

test('redactCandidateNameToRole: capitalizes at text and sentence start, lowercase mid-sentence', () => {
  assert.equal(
    redactCandidateNameToRole('Jamie built X. Then Jamie shipped Y.', FORMS),
    'The candidate built X. Then the candidate shipped Y.',
  )
  assert.equal(
    redactCandidateNameToRole('Wow! Jamie did it? Jamie did.', FORMS),
    'Wow! The candidate did it? The candidate did.',
  )
})

test('redactCandidateNameToRole: capitalizes at line starts, including indented lines', () => {
  assert.equal(
    redactCandidateNameToRole('line one\nJamie next\n  Jamie indented', FORMS),
    'line one\nThe candidate next\n  The candidate indented',
  )
})

test('redactCandidateNameToRole: opening quotes and brackets at sentence start still capitalize', () => {
  for (const open of ['"', '“', '‘', '(', '[', '*']) {
    assert.equal(redactCandidateNameToRole(`${open}Jamie led`, FORMS), `${open}The candidate led`, `opener ${open}`)
  }
})

test('redactCandidateNameToRole: full name collapses to a single phrase', () => {
  assert.equal(redactCandidateNameToRole('Jamie Doe built X', FORMS), 'The candidate built X')
})

test('redactCandidateNameToRole: surname alone is redacted too', () => {
  assert.equal(redactCandidateNameToRole('Asked about Doe', FORMS), 'Asked about the candidate')
})

test('redactCandidateNameToRole: possessives keep their apostrophe-s', () => {
  assert.equal(
    redactCandidateNameToRole("No. Jamie's history and Jamie’s projects", FORMS),
    "No. The candidate's history and the candidate's projects",
  )
})

test('redactCandidateNameToRole: quoted mid-sentence stays lowercase; eval "A:" prefix capitalizes', () => {
  assert.equal(
    redactCandidateNameToRole("third-person narration ('Jamie built')", FORMS),
    "third-person narration ('the candidate built')",
  )
  assert.equal(redactCandidateNameToRole('  A: Jamie has nine projects', FORMS), '  A: The candidate has nine projects')
  assert.equal(redactCandidateNameToRole('**Jamie** led', FORMS), '**The candidate** led')
})

test('redactCandidateNameToRole: case-insensitive, whole-word only', () => {
  assert.equal(redactCandidateNameToRole('asked JAMIE', FORMS), 'asked the candidate')
  assert.equal(redactCandidateNameToRole('Jamieson and Doeling', FORMS), 'Jamieson and Doeling')
})

test('redactCandidateNameToRole: non-ASCII names match whole-word without clipping', () => {
  const forms = candidateNameForms('Zoë Lindqvist')
  assert.equal(redactCandidateNameToRole('Asked Zoë and ZOË', forms), 'Asked the candidate and the candidate')
  // An ASCII \b boundary would split after the "ë" and redact inside this longer word.
  assert.equal(redactCandidateNameToRole('Zoëlle is someone else', forms), 'Zoëlle is someone else')
})

test('redactCandidateNameToRole: an empty form is skipped rather than matching everywhere', () => {
  assert.equal(redactCandidateNameToRole('Jamie built X', ['', 'Jamie']), 'The candidate built X')
})

test('redactCandidateNameToRole: no-op with no forms', () => {
  assert.equal(redactCandidateNameToRole('Jamie built X', []), 'Jamie built X')
})

// ── installOutputRedaction ───────────────────────────────────

test('installOutputRedaction: redacts string and Buffer writes on the given streams', () => {
  let captured = ''
  const sink = new Writable({ write(chunk: Buffer, _enc, cb) { captured += chunk.toString('utf8'); cb() } })
  const stream = sink as unknown as NodeJS.WriteStream
  installOutputRedaction(FORMS, [stream])
  stream.write('Jamie built X\n')
  stream.write(Buffer.from('[query] parse_error: Jamie Doe said hi\n'))
  assert.equal(captured, 'The candidate built X\n[query] parse_error: The candidate said hi\n')
})
