/**
 * Weekly judge sweep over production traffic (#205) — the loop that grows
 * the golden set from organic visitors, the last remaining piece of #195.
 *
 *   npx tsx scripts/eval/judge-sweep.ts               # real run — files/updates an arbitration issue
 *   npx tsx scripts/eval/judge-sweep.ts --dry-run      # print the report, file no issue
 *
 * 1. Pulls distinct questions from observed_queries over the last 8 days
 *    (7-day cadence + 1-day overlap).
 * 2. Derives the route production actually served per question from the
 *    action_intent / fit_question columns (deriveServedRoute in
 *    judge-sweep-lib.ts — verified against src/routes/query.ts).
 * 3. Dedupes against the golden set (scripts/eval/route-cases.ts) and
 *    against questions already listed in a previously-filed OPEN
 *    arbitration issue (label eval-arbitration) — cost discipline: judge the
 *    delta, never the corpus.
 * 4. Judges what's left through classifyRoute() with the trusted judge model
 *    (JUDGE_MODEL) via OPENROUTER_API_KEY_EVAL — same model-override +
 *    key-preference machinery run-route-eval.ts uses (eval-env.js swaps in
 *    the eval key; classifyRoute takes the model as an explicit override).
 * 5. Disagreements are an ARBITRATION QUEUE, not a failure: file/update a
 *    GitHub issue listing them for human decision. Zero disagreements logs a
 *    clean summary and files nothing.
 *
 * Exit codes: 0 on a clean run OR a run that filed/updated an arbitration
 * issue for disagreements — disagreements are expected, not exceptional.
 * 1 is reserved for infrastructure errors: DB unreachable, the judge model
 * call failing, missing env, or a `gh` failure while filing.
 */

// First import: see eval-route-eval.ts's identical comment — must run before
// ai.ts's module-level client reads OPENROUTER_API_KEY (#201 key isolation).
import './eval-env.js'

import { execFileSync } from 'node:child_process'
import { supabase } from '../../src/lib/supabase.js'
import { classifyRoute } from '../../src/lib/route-classifier.js'
import { fetchCandidateName } from '../../src/routes/query.js'
import { ROUTE_CASES } from './route-cases.js'
import {
  ARBITRATION_LABEL,
  JUDGE_MODEL,
  QUERY_ROW_CAP,
  WINDOW_DAYS,
  buildArbitrationSection,
  buildCleanSummaryLine,
  deriveServedRoute,
  distinctByNormalizedQuestion,
  filterNewQuestions,
  extractQuestionsFromIssueText,
  formatReport,
  issueTitle,
  normalizeQuestion,
  redactCandidateName,
  type Disagreement,
  type JudgedEntry,
  type ObservedRow,
} from './judge-sweep-lib.js'

function parseFlags(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes('--dry-run') }
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

interface OpenArbitrationIssue {
  number: number
  text: string
}

/** The single standing open arbitration issue (if any), body + all comments concatenated for dedupe scanning. */
function findOpenArbitrationIssue(): OpenArbitrationIssue | null {
  const listJson = gh(['issue', 'list', '--label', ARBITRATION_LABEL, '--state', 'open', '--json', 'number', '--limit', '1'])
  const list = JSON.parse(listJson) as { number: number }[]
  if (!list.length) return null
  const number = list[0].number
  const viewJson = gh(['issue', 'view', String(number), '--json', 'body,comments'])
  const view = JSON.parse(viewJson) as { body: string; comments: { body: string }[] }
  return { number, text: [view.body, ...view.comments.map((c) => c.body)].join('\n') }
}

/** Best-effort: the label may already exist (fine) or this may race another run (fine) — issue creation is what must succeed. */
function ensureLabel(): void {
  try {
    gh([
      'label',
      'create',
      ARBITRATION_LABEL,
      '--color',
      'B60205',
      '--description',
      'Weekly judge sweep flagged a served-route vs judge-route disagreement for human arbitration',
    ])
  } catch {
    // already exists
  }
}

async function main(): Promise<void> {
  const { dryRun } = parseFlags(process.argv.slice(2))
  const isoDate = new Date().toISOString().slice(0, 10)

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('observed_queries')
    .select('question, action_intent, fit_question, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(QUERY_ROW_CAP)

  if (error) {
    process.stderr.write(`judge-sweep: observed_queries query failed: ${error.message}\n`)
    process.exit(1)
  }

  const rawRows = (data ?? []) as ObservedRow[]
  if (rawRows.length === QUERY_ROW_CAP) {
    // The window returned exactly the row cap — almost certainly truncated. The sweep
    // must never silently claim full-window coverage it doesn't have.
    process.stderr.write(
      `judge-sweep: WARNING — observed_queries returned the row cap (${QUERY_ROW_CAP}); ` +
        `the ${WINDOW_DAYS}d window is likely truncated and some questions were not swept.\n`,
    )
  }

  // Redact the candidate's real name out of every question as early as
  // possible — before dedup, judging, the stdout report, or (especially) the
  // public GitHub arbitration issue body. See redactCandidateName's doc
  // comment: this also keeps dedupe consistent with route-cases.ts, which
  // already stores promoted questions with the real name swapped for
  // DEFAULT_CANDIDATE_NAME by convention.
  const candidateName = await fetchCandidateName()
  const rows = rawRows.map((r) => ({ ...r, question: redactCandidateName(r.question, candidateName) }))

  const distinct = distinctByNormalizedQuestion(rows)

  const routeCaseQuestions = ROUTE_CASES.map((c) => normalizeQuestion(c.question))

  let existingIssue: OpenArbitrationIssue | null = null
  try {
    existingIssue = findOpenArbitrationIssue()
  } catch (err) {
    process.stderr.write(`judge-sweep: failed to look up the standing arbitration issue: ${(err as Error).message}\n`)
    process.exit(1)
    return
  }
  const arbitrationQuestions = existingIssue ? extractQuestionsFromIssueText(existingIssue.text).map(normalizeQuestion) : []

  const known = new Set([...routeCaseQuestions, ...arbitrationQuestions])
  const newQuestions = filterNewQuestions(distinct, known)

  process.stdout.write(
    `judge-sweep: window=${WINDOW_DAYS}d observed=${rows.length} distinct=${distinct.length} ` +
      `new=${newQuestions.length} (skipped ${distinct.length - newQuestions.length} already-known)\n`,
  )

  if (!newQuestions.length) {
    process.stdout.write(buildCleanSummaryLine(isoDate, 0) + '\n')
    process.exit(0)
  }

  const judged: JudgedEntry[] = []
  for (const row of newQuestions) {
    const servedRoute = deriveServedRoute(row)
    let judgeRoute
    try {
      judgeRoute = await classifyRoute(row.question, JUDGE_MODEL)
    } catch (err) {
      process.stderr.write(`judge-sweep: judge model call failed: ${(err as Error).message}\n`)
      process.exit(1)
      return
    }
    judged.push({ question: row.question, servedRoute, judgeRoute, lastObserved: row.created_at })
  }

  const report = formatReport({
    isoDate,
    windowDays: WINDOW_DAYS,
    observedTotal: rows.length,
    distinctTotal: distinct.length,
    newTotal: newQuestions.length,
    judged,
  })
  process.stdout.write('\n' + report + '\n')

  const disagreements: Disagreement[] = judged
    .filter((j) => j.servedRoute !== j.judgeRoute)
    .map((j) => ({ question: j.question, servedRoute: j.servedRoute, judgeRoute: j.judgeRoute, lastObserved: j.lastObserved }))

  if (dryRun) {
    process.stdout.write('\n[dry-run] no issue filed.\n')
    process.exit(0)
  }

  if (!disagreements.length) {
    process.stdout.write('\n' + buildCleanSummaryLine(isoDate, judged.length) + '\n')
    process.exit(0)
  }

  const section = buildArbitrationSection(disagreements, isoDate)
  try {
    if (existingIssue) {
      gh(['issue', 'comment', String(existingIssue.number), '--body', section])
      process.stdout.write(`\nUpdated arbitration issue #${existingIssue.number} with ${disagreements.length} new disagreement(s).\n`)
    } else {
      ensureLabel()
      gh(['issue', 'create', '--title', issueTitle(isoDate), '--label', ARBITRATION_LABEL, '--body', section])
      process.stdout.write(`\nFiled new arbitration issue: ${issueTitle(isoDate)}\n`)
    }
  } catch (err) {
    process.stderr.write(`judge-sweep: failed to file/update the arbitration issue: ${(err as Error).message}\n`)
    process.exit(1)
    return
  }

  process.exit(0)
}

main().catch((err) => {
  process.stderr.write(`judge-sweep crashed: ${(err as Error).message}\n`)
  process.exit(1)
})
