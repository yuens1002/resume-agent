/**
 * Unit tests — scripts/eval/judge-sweep-lib.ts (#205)
 *
 * Pure logic only: normalization/dedupe, served-route derivation, and
 * report/issue-body formatting. No DB, no OpenRouter, no `gh` — those live
 * in the orchestrator (judge-sweep.ts), which is exercised via
 * `--dry-run` per the gate, not here.
 *
 * Per the gate-sampling rule, example question fixtures use a deliberately
 * worst-shaped string (multi-line, embedded quotes, unicode) rather than a
 * friendly one.
 *
 * Run: npm run test:unit
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ARBITRATION_LABEL,
  JUDGE_MODEL,
  WINDOW_DAYS,
  buildArbitrationSection,
  buildCleanSummaryLine,
  deriveServedRoute,
  distinctByNormalizedQuestion,
  extractQuestionsFromIssueText,
  filterNewQuestions,
  formatReport,
  issueTitle,
  normalizeQuestion,
  type Disagreement,
  type ObservedRow,
} from '../scripts/eval/judge-sweep-lib.js'

// Deliberately the worst-shaped example: multi-line, an em dash, embedded
// double quotes, currency, and unicode (accent + CJK + emoji).
const NASTY_QUESTION =
  'Can you check if Alex "really" fits this role?\n' +
  'Senior Backend Engineer — 5+ yrs, café-friendly team, 你好 🚀\n' +
  'Budget: $150k–$180k'

// ── normalizeQuestion ────────────────────────────────────────

test('normalizeQuestion: trims, collapses whitespace (incl. newlines), lowercases', () => {
  const messy = `  ${NASTY_QUESTION.toUpperCase()}  `
  const tidy = normalizeQuestion(NASTY_QUESTION)
  assert.equal(normalizeQuestion(messy), tidy)
  assert.equal(tidy, tidy.toLowerCase())
  assert.ok(!tidy.startsWith(' ') && !tidy.endsWith(' '))
  assert.ok(!/\s{2,}/.test(tidy), 'no run of 2+ whitespace chars should survive collapsing')
})

test('normalizeQuestion: case-only and whitespace-only variants normalize identically', () => {
  assert.equal(normalizeQuestion('Tell me   about\nyourself'), normalizeQuestion('tell me about yourself'))
})

// ── deriveServedRoute ────────────────────────────────────────

test('deriveServedRoute: non-null action_intent -> open_match_tool (mirrors query.ts:381)', () => {
  assert.equal(deriveServedRoute({ action_intent: 'open_match_tool', fit_question: false }), 'open_match_tool')
})

test('deriveServedRoute: null action_intent + fit_question true -> narrate_fit (mirrors query.ts:419)', () => {
  assert.equal(deriveServedRoute({ action_intent: null, fit_question: true }), 'narrate_fit')
})

test('deriveServedRoute: null action_intent + falsy fit_question -> narrate', () => {
  assert.equal(deriveServedRoute({ action_intent: null, fit_question: false }), 'narrate')
  assert.equal(deriveServedRoute({ action_intent: null, fit_question: null }), 'narrate')
})

test('deriveServedRoute: action_intent wins even if fit_question were also truthy (defensive — should never co-occur in practice)', () => {
  assert.equal(deriveServedRoute({ action_intent: 'open_match_tool', fit_question: true }), 'open_match_tool')
})

// ── distinctByNormalizedQuestion ─────────────────────────────

function row(question: string, created_at: string, overrides: Partial<ObservedRow> = {}): ObservedRow {
  return { question, action_intent: null, fit_question: null, created_at, ...overrides }
}

test('distinctByNormalizedQuestion: keeps the first (most recent, given sorted input) occurrence per normalized question', () => {
  const rows = [
    row(NASTY_QUESTION, '2026-07-11T10:00:00Z', { action_intent: 'open_match_tool' }),
    row(`  ${NASTY_QUESTION}  `, '2026-07-10T10:00:00Z', { action_intent: null }),
    row('Unrelated other question', '2026-07-09T10:00:00Z'),
  ]
  const distinct = distinctByNormalizedQuestion(rows)
  assert.equal(distinct.length, 2)
  assert.equal(distinct[0].created_at, '2026-07-11T10:00:00Z')
  assert.equal(distinct[0].action_intent, 'open_match_tool')
})

test('distinctByNormalizedQuestion: empty input -> empty output', () => {
  assert.deepEqual(distinctByNormalizedQuestion([]), [])
})

// ── filterNewQuestions ───────────────────────────────────────

test('filterNewQuestions: drops rows whose normalized question is in the known set', () => {
  const rows = [row(NASTY_QUESTION, '2026-07-11T10:00:00Z'), row('a brand new question', '2026-07-11T11:00:00Z')]
  const known = new Set([normalizeQuestion(NASTY_QUESTION)])
  const result = filterNewQuestions(rows, known)
  assert.equal(result.length, 1)
  assert.equal(result[0].question, 'a brand new question')
})

test('filterNewQuestions: known-set comparison is normalized (case/whitespace-insensitive)', () => {
  const rows = [row(`  ${NASTY_QUESTION.toUpperCase()}  `, '2026-07-11T10:00:00Z')]
  const known = new Set([normalizeQuestion(NASTY_QUESTION)])
  assert.deepEqual(filterNewQuestions(rows, known), [])
})

test('filterNewQuestions: empty known set keeps everything', () => {
  const rows = [row('q1', '2026-07-11T10:00:00Z'), row('q2', '2026-07-11T11:00:00Z')]
  assert.equal(filterNewQuestions(rows, []).length, 2)
})

// ── extractQuestionsFromIssueText <-> buildArbitrationSection round-trip ──

test('buildArbitrationSection -> extractQuestionsFromIssueText round-trips the verbatim question (multi-line/quotes/unicode preserved)', () => {
  const disagreements: Disagreement[] = [
    { question: NASTY_QUESTION, servedRoute: 'narrate', judgeRoute: 'open_match_tool', firstSeen: '2026-07-05T10:22:00.000Z' },
  ]
  const section = buildArbitrationSection(disagreements, '2026-07-11')
  const recovered = extractQuestionsFromIssueText(section)
  assert.deepEqual(recovered, [NASTY_QUESTION])
})

test('extractQuestionsFromIssueText: recovers every question across multiple disagreements and multiple sections concatenated', () => {
  const first = buildArbitrationSection(
    [{ question: 'first question', servedRoute: 'narrate', judgeRoute: 'narrate_fit', firstSeen: '2026-07-01T00:00:00Z' }],
    '2026-07-04',
  )
  const second = buildArbitrationSection(
    [
      { question: NASTY_QUESTION, servedRoute: 'narrate_fit', judgeRoute: 'open_match_tool', firstSeen: '2026-07-08T00:00:00Z' },
      { question: 'third question', servedRoute: 'open_match_tool', judgeRoute: 'narrate', firstSeen: '2026-07-09T00:00:00Z' },
    ],
    '2026-07-11',
  )
  const combined = [first, second].join('\n')
  assert.deepEqual(extractQuestionsFromIssueText(combined), ['first question', NASTY_QUESTION, 'third question'])
})

test('extractQuestionsFromIssueText: text with no disagreement blocks returns an empty array', () => {
  assert.deepEqual(extractQuestionsFromIssueText('Just some ordinary issue body with no fenced questions.'), [])
})

// A realistic shape for exactly the questions that hit the arbitration queue:
// a pasted JD containing its own ```-fenced code block. Regression test for
// the truncation bug where a fixed ```text fence + non-greedy match stopped
// at the question's own embedded fence.
const FENCED_QUESTION =
  'Please review this JD:\n' +
  '```js\n' +
  "const role = 'Senior Backend Engineer';\n" +
  '```\n' +
  'Does Alex fit?'

test('buildArbitrationSection -> extractQuestionsFromIssueText round-trips a question containing its own ``` fence without truncation', () => {
  const disagreements: Disagreement[] = [
    { question: FENCED_QUESTION, servedRoute: 'narrate', judgeRoute: 'open_match_tool', firstSeen: '2026-07-05T10:22:00.000Z' },
  ]
  const section = buildArbitrationSection(disagreements, '2026-07-11')
  const recovered = extractQuestionsFromIssueText(section)
  assert.deepEqual(recovered, [FENCED_QUESTION])
})

test('buildArbitrationSection -> extractQuestionsFromIssueText round-trips a question containing a longer (4-backtick) fence run', () => {
  const question = 'Outer fence:\n````\nnested ```text``` fence\n````\nDoes this fit?'
  const disagreements: Disagreement[] = [
    { question, servedRoute: 'narrate_fit', judgeRoute: 'narrate', firstSeen: '2026-07-06T00:00:00.000Z' },
  ]
  const section = buildArbitrationSection(disagreements, '2026-07-11')
  assert.deepEqual(extractQuestionsFromIssueText(section), [question])
})

test('buildArbitrationSection -> extractQuestionsFromIssueText round-trips multiple disagreements when some contain fences and some do not', () => {
  const disagreements: Disagreement[] = [
    { question: 'plain question', servedRoute: 'narrate', judgeRoute: 'narrate_fit', firstSeen: '2026-07-01T00:00:00Z' },
    { question: FENCED_QUESTION, servedRoute: 'narrate', judgeRoute: 'open_match_tool', firstSeen: '2026-07-02T00:00:00Z' },
  ]
  const section = buildArbitrationSection(disagreements, '2026-07-11')
  assert.deepEqual(extractQuestionsFromIssueText(section), ['plain question', FENCED_QUESTION])
})

test('buildArbitrationSection: zero disagreements produces a section that round-trips to zero questions', () => {
  const section = buildArbitrationSection([], '2026-07-11')
  assert.deepEqual(extractQuestionsFromIssueText(section), [])
  assert.match(section, /0 disagreement\(s\)/)
})

test('buildArbitrationSection: labels the timestamp "Last observed", not "First observed" (the value is the most recent occurrence — distinctByNormalizedQuestion keeps the first row of a most-recent-first-sorted list)', () => {
  const disagreements: Disagreement[] = [
    { question: 'plain question', servedRoute: 'narrate', judgeRoute: 'narrate_fit', firstSeen: '2026-07-05T10:22:00.000Z' },
  ]
  const section = buildArbitrationSection(disagreements, '2026-07-11')
  assert.match(section, /Last observed: 2026-07-05T10:22:00\.000Z/)
  assert.doesNotMatch(section, /First observed/)
})

// ── issueTitle / buildCleanSummaryLine ───────────────────────

test('issueTitle: uses the exact spec-mandated prefix and the given ISO date', () => {
  assert.equal(issueTitle('2026-07-11'), 'eval(arbitration): judge sweep — 2026-07-11')
})

test('buildCleanSummaryLine: reports zero disagreements and the judged count', () => {
  const line = buildCleanSummaryLine('2026-07-11', 7)
  assert.match(line, /2026-07-11/)
  assert.match(line, /0 disagreements/)
  assert.match(line, /7 new question/)
})

// ── formatReport ─────────────────────────────────────────────

test('formatReport: counts agreements and disagreements correctly, and lists each disagreement', () => {
  const report = formatReport({
    isoDate: '2026-07-11',
    windowDays: WINDOW_DAYS,
    observedTotal: 50,
    distinctTotal: 12,
    newTotal: 3,
    judged: [
      { question: 'agree one', servedRoute: 'narrate', judgeRoute: 'narrate', firstSeen: '2026-07-10T00:00:00Z' },
      { question: NASTY_QUESTION, servedRoute: 'narrate', judgeRoute: 'open_match_tool', firstSeen: '2026-07-10T01:00:00Z' },
      { question: 'agree two', servedRoute: 'narrate_fit', judgeRoute: 'narrate_fit', firstSeen: '2026-07-10T02:00:00Z' },
    ],
  })
  assert.match(report, /observed rows: 50/)
  assert.match(report, /distinct questions: 12/)
  assert.match(report, /new \(unlabeled\) questions judged: 3/)
  assert.match(report, /agreements: 2\/3/)
  assert.match(report, /disagreements: 1/)
  assert.match(report, /served=narrate\s+judge=open_match_tool/)
  // The multi-line question is flattened to one line in the summary report
  // (full verbatim text lives in the issue body via buildArbitrationSection).
  assert.doesNotMatch(report.split('Q: ')[1] ?? '', /\n/)
})

test('formatReport: zero judged questions reports zero agreements without dividing by zero visibly', () => {
  const report = formatReport({ isoDate: '2026-07-11', windowDays: WINDOW_DAYS, observedTotal: 0, distinctTotal: 0, newTotal: 0, judged: [] })
  assert.match(report, /agreements: 0\/0/)
  assert.match(report, /disagreements: 0/)
})

// ── Constants sanity (guard against silent drift) ────────────

test('constants: WINDOW_DAYS is 8 (7-day cadence + 1-day overlap, per #205)', () => {
  assert.equal(WINDOW_DAYS, 8)
})

test('constants: JUDGE_MODEL is the trusted judge model from #195/#205', () => {
  assert.equal(JUDGE_MODEL, 'anthropic/claude-sonnet-4.5')
})

test('constants: ARBITRATION_LABEL is a stable, grep-friendly label name', () => {
  assert.equal(ARBITRATION_LABEL, 'eval-arbitration')
})
