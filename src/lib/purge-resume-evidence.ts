import { z } from 'zod'

// ── CLI argument parsing ─────────────────────────────────────
//
// Default (no flags) is a dry run: it only reads counts and refuses nothing.
// Applying requires BOTH --apply and --expect-drafts <n> together — the
// script never deletes from a bare --apply, and --expect-drafts without
// --apply is refused as meaningless (a dry run never deletes, so there is
// nothing to confirm a count against).

export type PurgeArgs =
  | { mode: 'dry_run' }
  | { mode: 'apply'; expectedDrafts: number }

export type PurgeArgsRefusal = { status: 'refused'; reason: string }
export type PurgeArgsResult = { status: 'ok'; args: PurgeArgs } | PurgeArgsRefusal

function refuseArgs(reason: string): PurgeArgsRefusal {
  return { status: 'refused', reason }
}

export function parsePurgeArgs(argv: string[]): PurgeArgsResult {
  let apply = false
  let sawApply = false
  let sawExpectDrafts = false
  let expectDrafts: number | undefined

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--apply') {
      if (sawApply) return refuseArgs('--apply was passed more than once')
      sawApply = true
      apply = true
      continue
    }
    if (token === '--expect-drafts') {
      if (sawExpectDrafts) return refuseArgs('--expect-drafts was passed more than once')
      sawExpectDrafts = true
      const raw = argv[++i]
      if (raw === undefined) return refuseArgs('--expect-drafts requires a value')
      if (!/^\d+$/.test(raw)) return refuseArgs(`--expect-drafts must be a non-negative integer, got "${raw}"`)
      expectDrafts = Number(raw)
      continue
    }
    return refuseArgs(`Unknown flag: ${token}`)
  }

  if (apply && !sawExpectDrafts) return refuseArgs('--apply requires --expect-drafts <n>')
  if (!apply && sawExpectDrafts) return refuseArgs('--expect-drafts requires --apply (a dry run never deletes, so there is nothing to confirm a count against)')

  return {
    status: 'ok',
    args: apply ? { mode: 'apply', expectedDrafts: expectDrafts! } : { mode: 'dry_run' },
  }
}

// ── purge_resume_evidence() response contract ───────────────
//
// A draft with at least one recorded application_observed_outcomes row (a
// real reply was observed against it) is PROMOTED to 'applied' instead of
// deleted — deleting it would destroy the one piece of independent evidence
// that it was ever sent. `delete_count` — the drafts actually removed — is
// always draft_count - promote_count, and is what --expect-drafts must
// match, never the raw draft_count.

export const PurgeReportSchema = z.object({
  mode: z.enum(['dry_run', 'apply']),
  applied: z.boolean(),
  draft_count: z.number().int().nonnegative(),
  promote_count: z.number().int().nonnegative(),
  delete_count: z.number().int().nonnegative(),
  blocking: z.object({
    // Defensive only — see the migration header. By construction every
    // draft with an observed outcome is promoted, not deleted, so this is
    // always 0 in normal operation.
    draft_observed_outcomes_remaining: z.number().int().nonnegative(),
  }).strict(),
  counts: z.object({
    application_submission_confirmations: z.number().int().nonnegative(),
    application_resume_recovery_imports: z.number().int().nonnegative(),
    application_outcome_check_observations: z.number().int().nonnegative(),
    application_resumes: z.number().int().nonnegative(),
    application_evidence_snapshot_entries: z.number().int().nonnegative(),
    application_evidence_snapshots: z.number().int().nonnegative(),
    application_scores_resume_id_to_null: z.number().int().nonnegative(),
  }).strict(),
}).strict()

export type PurgeReport = z.infer<typeof PurgeReportSchema>

export function isPurgeBlocked(report: PurgeReport): boolean {
  return report.blocking.draft_observed_outcomes_remaining > 0
}

// ── --apply gate ──────────────────────────────────────────────
//
// The dry run above reports a storage listing's errors but never blocks on
// them (the caller's preview is read-only anyway). --apply is different: it
// drives an irreversible DB purge of application_resumes/resume_versions
// rows, so an incomplete storage listing — one that couldn't fully enumerate
// resume-artifacts — must refuse before that DB call, not after. Applying
// against an incomplete inventory would leave orphaned storage objects with
// no database row left to find them by, with no way to tell afterward that
// anything was missed.
//
// runApplyDecision takes the already-fetched preview report and storage
// list errors, runs every refusal check the apply path requires (storage
// preflight, --expect-drafts match, the defensive blocking check), and only
// then calls the injected applyRpc — exported with that injection so a test
// can stub a storage list error and assert applyRpc is never invoked.

export type ApplyRpcResult = { data: unknown; error: { message?: string } | null }

export type ApplyDecision =
  | { status: 'refused'; reason: string }
  | { status: 'applied'; report: PurgeReport }

export async function runApplyDecision(
  preview: PurgeReport,
  expectedDrafts: number,
  storageListErrors: string[],
  applyRpc: (expectedDrafts: number) => PromiseLike<ApplyRpcResult>,
): Promise<ApplyDecision> {
  if (storageListErrors.length > 0) {
    return {
      status: 'refused',
      reason: `Refused: storage listing reported ${storageListErrors.length} error(s) above — the artifact inventory is incomplete. Resolve them and re-run before applying.`,
    }
  }
  if (expectedDrafts !== preview.delete_count) {
    return {
      status: 'refused',
      reason: `Refused: --expect-drafts ${expectedDrafts} does not match the current "drafts to delete" count ${preview.delete_count} (${preview.promote_count} draft(s) will be promoted, not deleted). Re-run the dry run and pass the current count.`,
    }
  }
  if (isPurgeBlocked(preview)) {
    return { status: 'refused', reason: 'Refused: resolve the blocking row(s) reported above before applying.' }
  }

  const { data, error } = await applyRpc(expectedDrafts)
  if (error || !data) {
    return { status: 'refused', reason: `Purge refused by the database: ${error?.message ?? 'no data returned'}` }
  }
  const applied = PurgeReportSchema.safeParse(data)
  if (!applied.success) {
    return { status: 'refused', reason: 'Unexpected response shape from purge_resume_evidence (apply).' }
  }
  return { status: 'applied', report: applied.data }
}

export function formatPurgeReport(report: PurgeReport): string {
  const verbed = report.applied ? 'Removed / promoted' : 'Would remove / promote'
  const lines = [
    `Mode: ${report.mode}${report.applied ? ' (applied)' : ' (no changes made)'}`,
    `Draft applications: ${report.draft_count} total`,
    '',
    `${verbed}:`,
    `  drafts to promote (reply observed, stage -> applied): ${report.promote_count}`,
    `  drafts to delete: ${report.delete_count}`,
    `  application_outcome_check_observations (on drafts to delete): ${report.counts.application_outcome_check_observations}`,
    `  application_submission_confirmations: ${report.counts.application_submission_confirmations}`,
    `  application_resume_recovery_imports: ${report.counts.application_resume_recovery_imports}`,
    `  application_resumes: ${report.counts.application_resumes}`,
    `  application_evidence_snapshot_entries: ${report.counts.application_evidence_snapshot_entries}`,
    `  application_evidence_snapshots: ${report.counts.application_evidence_snapshots}`,
    `  application_scores.resume_id to be nulled (score rows themselves stay): ${report.counts.application_scores_resume_id_to_null}`,
  ]
  if (isPurgeBlocked(report)) {
    lines.push(
      '',
      'BLOCKED (defensive check tripped) — an observed-outcome row remains attached to a draft marked for deletion:',
      `  application_observed_outcomes remaining on a deleted-bound draft: ${report.blocking.draft_observed_outcomes_remaining}`,
    )
  }
  return lines.join('\n')
}

// ── Storage bucket purge ─────────────────────────────────────
//
// Supabase storage `.list()` returns one folder level at a time, paginated
// — the client's own default page size is 100 — and a folder entry has
// `id: null` (it is synthetic, not a real object row). The resume-artifacts
// bucket has one top-level folder per application (200+ in production), so
// a single unpaginated call at the root silently stops after the first 100
// and both the dry-run count and the actual delete would miss everything
// past it without ever surfacing an error. listAllObjectPaths pages every
// level — root and every nested folder — with an explicit {limit, offset},
// continuing until a page comes back shorter than the limit (the signal
// there is nothing left), before recursing into any folder it found.

export type StorageEntry = { name: string; id: string | null }
export type StorageListOptions = { limit: number; offset: number }
export type StorageLike = {
  list: (path: string, options: StorageListOptions) => PromiseLike<{ data: StorageEntry[] | null; error: unknown | null }>
  remove: (paths: string[]) => PromiseLike<{ data: unknown; error: unknown | null }>
}

const REMOVE_BATCH_SIZE = 100
const LIST_PAGE_SIZE = 100

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return String(error)
}

async function listAllObjectPaths(storage: StorageLike, prefix = ''): Promise<{ paths: string[]; listErrors: string[] }> {
  const paths: string[] = []
  const listErrors: string[] = []
  let offset = 0

  for (;;) {
    let page: StorageEntry[]
    try {
      const result = await storage.list(prefix, { limit: LIST_PAGE_SIZE, offset })
      if (result.error) {
        listErrors.push(`${prefix || '/'}: ${describeError(result.error)}`)
        break
      }
      page = result.data ?? []
    } catch (error) {
      listErrors.push(`${prefix || '/'}: ${describeError(error)}`)
      break
    }

    for (const entry of page) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.id === null) {
        const nested = await listAllObjectPaths(storage, fullPath)
        paths.push(...nested.paths)
        listErrors.push(...nested.listErrors)
      } else {
        paths.push(fullPath)
      }
    }

    // A page shorter than the limit is the only reliable "no more pages"
    // signal — an exact-multiple-of-limit bucket must make one more,
    // correctly empty, call rather than guess it is done.
    if (page.length < LIST_PAGE_SIZE) break
    offset += LIST_PAGE_SIZE
  }

  return { paths, listErrors }
}

export type StorageCountResult = {
  count: number
  listErrors: string[]
}

/** Read-only: lists every object without removing anything, for the dry-run report. */
export async function countStorageBucketObjects(storage: StorageLike): Promise<StorageCountResult> {
  const { paths, listErrors } = await listAllObjectPaths(storage)
  return { count: paths.length, listErrors }
}

export type StoragePurgeResult = {
  listed: number
  removed: number
  failed: string[]
}

export async function purgeStorageBucket(storage: StorageLike): Promise<StoragePurgeResult> {
  const { paths, listErrors } = await listAllObjectPaths(storage)
  const failed = [...listErrors]
  let removed = 0

  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const batch = paths.slice(i, i + REMOVE_BATCH_SIZE)
    try {
      const { error } = await storage.remove(batch)
      if (error) failed.push(...batch.map(path => `${path}: ${describeError(error)}`))
      else removed += batch.length
    } catch (error) {
      failed.push(...batch.map(path => `${path}: ${describeError(error)}`))
    }
  }

  return { listed: paths.length, removed, failed }
}
