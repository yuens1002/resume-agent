/**
 * Pure logic for the weekly judge sweep (#205) — extracted so it is
 * unit-testable without a live Supabase connection, OpenRouter call, or `gh`
 * CLI invocation. `judge-sweep.ts` is the orchestrator: it wires these
 * functions to the DB, the judge model, and the GitHub issue that tracks
 * arbitration.
 *
 * The sweep turns organic production traffic into golden-set growth:
 *   1. Pull recent distinct questions from `observed_queries`.
 *   2. Derive the route production actually served per question (from the
 *      `action_intent` / `fit_question` columns — see deriveServedRoute).
 *   3. Skip questions already in the golden set (scripts/eval/route-cases.ts)
 *      or already flagged in a previously-filed OPEN arbitration issue.
 *   4. Judge what's left with a trusted stronger model.
 *   5. Disagreements go to an arbitration issue for human decision — never a
 *      CI failure (see judge-sweep.ts's exit-code contract).
 *
 * Import type { Route } from route-classifier.js — type-only, so this module
 * never needs OPENROUTER_API_KEY at import time (route-classifier.ts's
 * runtime code pulls in the `ai` SDK, which route-cases.ts avoids the same
 * way). Safe to import from tests/judge-sweep.test.ts without env setup.
 */

import type { Route } from '../../src/lib/route-classifier.js'

// ── Constants ────────────────────────────────────────────────

/** 7-day cadence + 1-day overlap, per #205. */
export const WINDOW_DAYS = 8

/**
 * Trust established by 224/224 golden-set convergence (#195/#205) — same
 * judge model the weekly parity run (eval-weekly.yml's route-judge step)
 * already uses.
 */
export const JUDGE_MODEL = 'anthropic/claude-sonnet-4.5'

/** Label used to find the single standing open arbitration issue, mirroring eval-weekly.yml's eval-parity pattern. */
export const ARBITRATION_LABEL = 'eval-arbitration'

// ── Types ────────────────────────────────────────────────────

export interface ObservedRow {
  question: string
  action_intent: string | null
  fit_question: boolean | null
  created_at: string
}

export interface Disagreement {
  question: string
  servedRoute: Route
  judgeRoute: Route
  firstSeen: string
}

export interface JudgedEntry {
  question: string
  servedRoute: Route
  judgeRoute: Route
  firstSeen: string
}

// ── Normalization + dedupe ──────────────────────────────────

/** Trim, collapse whitespace (incl. newlines), lowercase — per #205's dedupe rule. */
export function normalizeQuestion(question: string): string {
  return question.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Collapse observed_queries rows down to one per distinct (normalized)
 * question — "recent distinct visitor questions" (#205). Expects rows sorted
 * most-recent-first (as the DB query already orders them) so the row kept
 * for each question is its most recent occurrence, i.e. the route production
 * is currently serving for that phrasing.
 */
export function distinctByNormalizedQuestion(rowsMostRecentFirst: ObservedRow[]): ObservedRow[] {
  const seen = new Set<string>()
  const out: ObservedRow[] = []
  for (const row of rowsMostRecentFirst) {
    const key = normalizeQuestion(row.question)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

/** Rows whose normalized question is NOT in `knownNormalized`. */
export function filterNewQuestions(rows: ObservedRow[], knownNormalized: Iterable<string>): ObservedRow[] {
  const known = new Set(knownNormalized)
  return rows.filter((row) => !known.has(normalizeQuestion(row.question)))
}

// ── Served-route derivation ─────────────────────────────────

/**
 * The route production actually served for one observed_queries row.
 * Mirrors src/routes/query.ts exactly: action_intent is set (to the tool
 * name) only on the open_match_tool branch; fit_question is true only on
 * the narrate_fit branch; both are null/false on plain narrate.
 */
export function deriveServedRoute(row: Pick<ObservedRow, 'action_intent' | 'fit_question'>): Route {
  if (row.action_intent) return 'open_match_tool'
  if (row.fit_question) return 'narrate_fit'
  return 'narrate'
}

// ── Arbitration issue: dedupe against previously-flagged questions ─────

/**
 * Picks a fenced-code-block delimiter strictly longer than the longest run
 * of backticks appearing anywhere in `text`. CommonMark allows fences of any
 * length >= 3, and a closing fence only terminates the block if it has at
 * least as many backticks as the opener — so a fence chosen this way can
 * never be confused with a backtick run the question itself contains (e.g.
 * a pasted JD with an embedded ```-fenced code sample).
 */
function pickFence(text: string): string {
  const runs = text.match(/`+/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

// Matches the fenced block buildArbitrationSection writes for each
// disagreement: a "**Question:**" label followed by a fenced block. The
// fence length is captured and re-matched via backreference (\1) as the
// closing fence, so fences of any length (chosen per-question by pickFence)
// round-trip correctly instead of stopping at the first ``` regardless of
// what opened the block.
const QUESTION_BLOCK_RE = /\*\*Question:\*\*\n(`{3,})text\n([\s\S]*?)\n\1\n/g

/** Recover the verbatim question text from every disagreement block in an issue body/comment (or the two concatenated). */
export function extractQuestionsFromIssueText(text: string): string[] {
  return [...text.matchAll(QUESTION_BLOCK_RE)].map((m) => m[2])
}

// ── Report + issue-body formatting ──────────────────────────

export function issueTitle(isoDate: string): string {
  return `eval(arbitration): judge sweep — ${isoDate}`
}

/**
 * One dated section documenting this run's disagreements — used both as a
 * brand-new issue's body and as a comment appended to a standing open issue.
 */
export function buildArbitrationSection(disagreements: Disagreement[], isoDate: string): string {
  const lines: string[] = [
    `## Judge sweep — ${isoDate}`,
    '',
    `${disagreements.length} disagreement(s) between the route production served and the judge model ` +
      `(\`${JUDGE_MODEL}\`) on new production questions — not yet in the golden set ` +
      '(scripts/eval/route-cases.ts) or a previously-filed open arbitration issue.',
    '',
  ]
  disagreements.forEach((d, i) => {
    const fence = pickFence(d.question)
    lines.push(
      `### Disagreement ${i + 1}`,
      '',
      `- Served route: \`${d.servedRoute}\``,
      `- Judge route: \`${d.judgeRoute}\``,
      // `d.firstSeen` is the created_at of the row distinctByNormalizedQuestion
      // kept, which (given rows are queried most-recent-first) is this
      // question's most recent observed occurrence, not its first.
      `- Last observed: ${d.firstSeen}`,
      '',
      '**Question:**',
      `${fence}text`,
      d.question,
      fence,
      '',
    )
  })
  return lines.join('\n')
}

export function buildCleanSummaryLine(isoDate: string, judgedCount: number): string {
  return `judge sweep ${isoDate}: 0 disagreements across ${judgedCount} new question(s) — no arbitration issue filed.`
}

export interface ReportInput {
  isoDate: string
  windowDays: number
  observedTotal: number
  distinctTotal: number
  newTotal: number
  judged: JudgedEntry[]
}

/** Human-readable stdout report — printed on every run, including --dry-run. */
export function formatReport(input: ReportInput): string {
  const disagreements = input.judged.filter((j) => j.servedRoute !== j.judgeRoute)
  const lines: string[] = [
    `── Judge sweep — ${input.isoDate} ─────────────────`,
    `  window: last ${input.windowDays}d`,
    `  observed rows: ${input.observedTotal}`,
    `  distinct questions: ${input.distinctTotal}`,
    `  new (unlabeled) questions judged: ${input.newTotal}`,
    `  agreements: ${input.judged.length - disagreements.length}/${input.judged.length}`,
    `  disagreements: ${disagreements.length}`,
  ]
  if (disagreements.length) {
    lines.push('', '── Disagreements ──────────────────────────────────')
    disagreements.forEach((d, i) => {
      const oneLine = d.question.replace(/\s+/g, ' ')
      lines.push(
        `  ${i + 1}. served=${d.servedRoute}  judge=${d.judgeRoute}  first_seen=${d.firstSeen}`,
        `     Q: ${oneLine.slice(0, 160)}${oneLine.length > 160 ? '…' : ''}`,
      )
    })
  }
  return lines.join('\n')
}
