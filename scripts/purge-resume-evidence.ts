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
// Usage:
//   tsx scripts/purge-resume-evidence.ts                           # dry run (default, changes nothing)
//   tsx scripts/purge-resume-evidence.ts --apply --expect-drafts N # execute; N must match the dry run's "drafts to delete" count
import { supabase } from '../src/lib/supabase.js'
import {
  parsePurgeArgs,
  PurgeReportSchema,
  formatPurgeReport,
  countStorageBucketObjects,
  purgeStorageBucket,
  runApplyDecision,
} from '../src/lib/purge-resume-evidence.js'

const RESUME_ARTIFACTS_BUCKET = 'resume-artifacts'

const parsedArgs = parsePurgeArgs(process.argv.slice(2))
if (parsedArgs.status === 'refused') {
  console.error(`Refused: ${parsedArgs.reason}`)
  console.error('Usage: tsx scripts/purge-resume-evidence.ts [--apply --expect-drafts <n>]')
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
const storageResult = await purgeStorageBucket(supabase.storage.from('resume-artifacts'))
console.log(`Storage objects removed: ${storageResult.removed} / ${storageResult.listed}`)
if (storageResult.failed.length > 0) {
  console.error(`Failed to remove ${storageResult.failed.length} storage object(s):`)
  for (const failure of storageResult.failed) console.error(`  - ${failure}`)
  process.exitCode = 1
}
