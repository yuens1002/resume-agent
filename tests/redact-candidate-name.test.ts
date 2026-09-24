import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidateNameForms, redactCandidateNameToRole } from '../scripts/eval/redact-candidate-name.js'

const FORMS = candidateNameForms('Jamie Doe', 'Jamie')

test('candidateNameForms: full name first, then each word, deduped', () => {
  assert.deepEqual(FORMS, ['Jamie Doe', 'Jamie', 'Doe'])
})

test('candidateNameForms: ignores empty and whitespace-only names', () => {
  assert.deepEqual(candidateNameForms('', '  '), [])
})

test('redactCandidateNameToRole: capitalizes at text and sentence start, lowercase mid-sentence', () => {
  assert.equal(
    redactCandidateNameToRole('Jamie built X. Then Jamie shipped Y.', FORMS),
    'The candidate built X. Then the candidate shipped Y.',
  )
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

test('redactCandidateNameToRole: no-op with no forms', () => {
  assert.equal(redactCandidateNameToRole('Jamie built X', []), 'Jamie built X')
})
