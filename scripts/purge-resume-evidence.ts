// One-time administrative purge of resume evidence that predates
// log_application recording submitted applications only (#308): existing
// draft applications and every application_resumes row (submitted ones
// included) still held resume content/file references the server no longer
// writes. See the README's "Resume-evidence purge" section before running
// this with --apply — it is irreversible.
//
// A draft with at least one recorded reply (application_observed_outcomes
// row) is promoted to 'applied' instead of deleted — see the migration
// header for why. --expect-drafts must equal the dry run's "drafts to
// delete" count, which already excludes anything about to be promoted —
// never the raw total draft count.
//
// Never run `npm run admin:recover-evidence` while this script is running
// with --apply: it is the one retained writer to application_resumes and
// resume-artifacts, and a row/object it inserts concurrently can race the
// storage walk below. The post-apply residue check exists to catch exactly
// that, but it cannot undo the race — don't rely on it, just don't run both
// at once.
//
// Usage:
//   tsx scripts/purge-resume-evidence.ts                           # dry run (default, changes nothing)
//   tsx scripts/purge-resume-evidence.ts --apply --expect-drafts N # execute; N must match the dry run's "drafts to delete" count
//   Never run alongside `npm run admin:recover-evidence` — see above.
import { supabase } from '../src/lib/supabase.js'
import {
  parsePurgeArgs,
  PurgeReportSchema,
  formatPurgeReport,
  countStorageBucketObjects,
  purgeStorageBucket,
  runApplyDecision,
  checkPostPurgeResidue,
  formatPostPurgeWarning,
} from '../src/lib/purge-resume-evidence.js'

const RESUME_ARTIFACTS_BUCKET = 'resume-artifacts'

const parsedArgs = parsePurgeArgs(process.argv.slice(2))
if (parsedArgs.status === 'refused') {
  console.error(`Refused: ${parsedArgs.reason}`)
  console.error('Usage: tsx scripts/purge-resume-evidence.ts [--apply --expect-drafts <n>]')
  console.error('Never run alongside `npm run admin:recover-evidence`.')
  process.exit(1)
}

const { data: previewData, error: previewError } = await supabase.rpc('purge_resume_evidence', { p_apply: false })
if (previewError || !previewData) {
  console.error(`Failed to read current purge counts: ${previewError?.message ?? 'no data returned'}`)
  process.exit(1)
}
const preview = PurgeReportSchema.safeParse(previewData)
if (!preview.success) {
  console.error('Unexpected response shape from purge_resume_evidence (dry run).')
  process.exit(1)
}
console.log(formatPurgeReport(preview.data))

const storageCount = await countStorageBucketObjects(supabase.storage.from(RESUME_ARTIFACTS_BUCKET))
console.log(`  ${RESUME_ARTIFACTS_BUCKET} storage objects: ${storageCount.count}`)
for (const listError of storageCount.listErrors) console.error(`  storage list error: ${listError}`)

if (parsedArgs.args.mode === 'dry_run') {
  console.log(`\nDry run only — nothing was changed. Re-run with --apply --expect-drafts ${preview.data.delete_count} (the "drafts to delete" count above, not the total) to execute.`)
  process.exit(0)
}

const decision = await runApplyDecision(
  preview.data,
  parsedArgs.args.expectedDrafts,
  storageCount.listErrors,
  expectedDrafts => supabase.rpc('purge_resume_evidence', { p_apply: true, p_expected_drafts: expectedDrafts }),
)
if (decision.status === 'refused') {
  console.error(`\n${decision.reason}`)
  process.exit(1)
}
console.log('\n' + formatPurgeReport(decision.report))

console.log('\nRemoving storage objects in resume-artifacts…')
const storageResult = await purgeStorageBucket(supabase.storage.from(RESUME_ARTIFACTS_BUCKET))
console.log(`Storage objects removed: ${storageResult.removed} / ${storageResult.listed}`)
if (storageResult.failed.length > 0) {
  console.error(`Failed to remove ${storageResult.failed.length} storage object(s):`)
  for (const failure of storageResult.failed) console.error(`  - ${failure}`)
  process.exitCode = 1
}

// Re-check after the fact: a concurrent admin:recover-evidence run (never
// supposed to happen alongside this script, but not locked out of it
// either) could have inserted a fresh application_resumes row and/or
// resume-artifacts object while the walk above was in flight. Reporting
// success without this check would hide that race.
console.log('\nRe-checking for residue (e.g. a concurrent admin:recover-evidence run)…')
const residue = await checkPostPurgeResidue(
  async () => {
    const { count, error } = await supabase.from('application_resumes').select('*', { count: 'exact', head: true })
    return { count: count ?? 0, error: error?.message ?? null }
  },
  supabase.storage.from(RESUME_ARTIFACTS_BUCKET),
)
if (residue.status === 'warn') {
  console.error('\n' + formatPostPurgeWarning(residue))
  process.exit(1)
}
console.log('Residue check clean — no application_resumes rows or resume-artifacts objects remain.')
