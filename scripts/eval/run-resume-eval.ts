/**
 * On-demand eval for `/resume` generation (#298 D8).
 *
 *   npm run eval:resume                 # every case
 *   npm run eval:resume -- --case <id>  # one case
 *
 * Runs each synthetic JD through the real `generateResume` core (two live
 * model calls per case, against the live profile) and checks the winning,
 * post-processed résumé against the invariants the pipeline promises. Any
 * failed check fails its case and is named.
 *
 * Not part of `test:unit` and not in any scheduled workflow: it makes live
 * model calls, so it's run before and after changes to the prompt, the
 * post-processing or the rubric.
 */

import './eval-env.js'
import { fetchProfile } from '../../src/lib/profile-cache.js'
import { generateResume } from '../../src/lib/generate-resume.js'
import { RESUME_BUDGET } from '../../src/lib/resume-format.js'
import type { ResumeResponse } from '../../src/types.js'
import { RESUME_EVAL_CASES } from './resume-eval-cases.js'

interface Check {
  name: string
  pass: boolean
  detail?: string
}

const NUMBER_RE = /\d+(?:[.,]\d+)*/g

/** Numbers appearing anywhere in the profile — the only numbers a bullet may cite. */
function profileNumbers(profile: unknown): Set<string> {
  return new Set(JSON.stringify(profile).match(NUMBER_RE) ?? [])
}

function checkResume(resume: ResumeResponse, profile: Record<string, any>, rules: { rule: number; pass: boolean; detail: string }[]): Check[] {
  const employment = resume.employment ?? []
  const unpinned = employment.filter((e) => e.pinned !== true)
  const bullets = employment.flatMap((e) => e.bullets ?? [])
  const highlights = (resume.projects ?? []).flatMap((p) => p.highlights ?? [])
  const checks: Check[] = []

  const periods = [...bullets, ...highlights].filter((b) => b.trim().endsWith('.'))
  checks.push({ name: 'no trailing periods', pass: periods.length === 0, detail: periods[0] })

  const sentences = (resume.summary ?? '').trim().split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean).length
  checks.push({ name: 'summary within budget', pass: sentences <= RESUME_BUDGET.summarySentences, detail: `${sentences} sentences` })

  const ordered = employment.every((e, i) => i === 0 || String(employment[i - 1].start_date) >= String(e.start_date))
  checks.push({ name: 'roles most recent first', pass: ordered })

  const overBudget = unpinned.filter((e) => (e.bullets ?? []).length > (employment.indexOf(e) === 0 ? RESUME_BUDGET.mostRecentRoleBullets : RESUME_BUDGET.otherRoleBullets))
  checks.push({ name: 'role bullets within budget', pass: overBudget.length === 0, detail: overBudget.map((e) => e.company).join(', ') })

  const projectsOk = (resume.projects ?? []).length <= RESUME_BUDGET.projects &&
    (resume.projects ?? []).every((p) => (p.highlights ?? []).length <= RESUME_BUDGET.projectHighlights)
  checks.push({ name: 'projects within budget', pass: projectsOk })

  const skills = (resume.skills ?? []) as unknown[]
  const categorized = skills.length > 0 && skills.every((s) => typeof s === 'object' && s !== null && Array.isArray((s as { items?: unknown }).items))
  checks.push({ name: 'skills categorized within budget', pass: categorized && skills.length <= RESUME_BUDGET.skillRows, detail: `${skills.length} rows, categorized=${categorized}` })

  const xyz = rules.find((r) => r.rule === 5)
  checks.push({ name: 'STAR/XYZ rule passes', pass: !!xyz?.pass, detail: xyz?.detail })

  const banned = rules.find((r) => r.rule === 4)
  checks.push({ name: 'no banned phrases', pass: !!banned?.pass, detail: banned?.detail })

  // Summary is excluded: years of experience are legitimately derived from dates.
  const known = profileNumbers(profile)
  const invented = [...bullets, ...highlights].flatMap((b) => (b.match(NUMBER_RE) ?? []).filter((n) => !known.has(n)).map((n) => `${n} in "${b}"`))
  checks.push({ name: 'no numbers absent from the profile', pass: invented.length === 0, detail: invented[0] })

  for (const pin of (profile.employment ?? []).filter((e: { pinned?: unknown }) => e?.pinned === true)) {
    const out = employment.find((e) => e.company === pin.company)
    const verbatim = !!out && JSON.stringify(out.bullets) === JSON.stringify(pin.bullets)
    checks.push({ name: `pinned role verbatim (${pin.company})`, pass: verbatim })
  }

  return checks
}

async function main(): Promise<void> {
  const caseArg = process.argv.indexOf('--case')
  const only = caseArg >= 0 ? process.argv[caseArg + 1] : undefined
  const cases = RESUME_EVAL_CASES.filter((c) => !only || c.id === only)
  if (!cases.length) {
    process.stderr.write(`No case matches --case ${only}\n`)
    process.exit(2)
  }

  const result = await fetchProfile()
  if (result.kind !== 'ok') {
    process.stderr.write(`Could not load the profile: ${result.kind}\n`)
    process.exit(2)
  }
  const profile = result.profile as Record<string, any>

  let failedCases = 0
  for (const c of cases) {
    process.stdout.write(`\n[${c.id}] (${c.roleType})\n`)
    const candidates = await generateResume({ profile, jobDescription: c.jobDescription })
    if (!candidates.length) {
      process.stdout.write('  FAIL — both generations failed to parse\n')
      failedCases++
      continue
    }
    const winner = candidates[0]
    const checks = checkResume(winner.resume, profile, winner.rubric.rules)
    for (const ch of checks) {
      process.stdout.write(`  ${ch.pass ? '✓' : '✗'} ${ch.name}${!ch.pass && ch.detail ? ` — ${ch.detail}` : ''}\n`)
    }
    const pass = checks.every((ch) => ch.pass)
    if (!pass) failedCases++
    process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  rubric ${winner.rubric.total.toFixed(2)}${winner.rubric.passed ? ' (passed)' : ' (below threshold)'}  model=${winner.model}\n`)
  }

  process.stdout.write(`\n${cases.length - failedCases}/${cases.length} cases passed\n`)
  process.exit(failedCases === 0 ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`Eval crashed: ${(err as Error).message}\n`)
  process.exit(2)
})
