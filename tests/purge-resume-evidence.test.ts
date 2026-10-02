/**
 * scripts/purge-resume-evidence.ts — planning/argument logic, the storage
 * step, and the migration's grants, all exercised hermetically (no network,
 * no real Supabase).
 *
 * The CLI parsing, report formatting, and storage-bucket purge are pure
 * functions in src/lib/purge-resume-evidence.ts, tested here with stubs. The
 * `purge_resume_evidence` SQL function runs the same production migration
 * files under PGlite (in-memory Postgres), matching the pattern established
 * by tests/application-submission-confirmation.test.ts and
 * tests/application-evidence-snapshot.test.ts.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import {
  parsePurgeArgs,
  formatPurgeReport,
  isPurgeBlocked,
  purgeStorageBucket,
  countStorageBucketObjects,
  runApplyDecision,
  checkPostPurgeResidue,
  formatPostPurgeWarning,
  type PurgeReport,
  type StorageEntry,
} from '../src/lib/purge-resume-evidence.js'
import { SECURITY_DEFINER_GRANTS_QUERY } from '../scripts/check-security-definer-grants.js'

// ── parsePurgeArgs ────────────────────────────────────────────

describe('parsePurgeArgs', () => {
  it('defaults to a dry run with no flags', () => {
    assert.deepEqual(parsePurgeArgs([]), { status: 'ok', args: { mode: 'dry_run' } })
  })

  it('accepts --apply with --expect-drafts <n>', () => {
    assert.deepEqual(
      parsePurgeArgs(['--apply', '--expect-drafts', '3']),
      { status: 'ok', args: { mode: 'apply', expectedDrafts: 3 } },
    )
    // Order independent.
    assert.deepEqual(
      parsePurgeArgs(['--expect-drafts', '0', '--apply']),
      { status: 'ok', args: { mode: 'apply', expectedDrafts: 0 } },
    )
  })

  it('refuses --apply without --expect-drafts', () => {
    assert.equal(parsePurgeArgs(['--apply']).status, 'refused')
  })

  it('refuses --expect-drafts without --apply (a dry run never deletes)', () => {
    assert.equal(parsePurgeArgs(['--expect-drafts', '3']).status, 'refused')
  })

  it('refuses a non-numeric or missing --expect-drafts value', () => {
    assert.equal(parsePurgeArgs(['--apply', '--expect-drafts', 'three']).status, 'refused')
    assert.equal(parsePurgeArgs(['--apply', '--expect-drafts', '-1']).status, 'refused')
    assert.equal(parsePurgeArgs(['--apply', '--expect-drafts']).status, 'refused')
  })

  it('refuses a duplicated flag', () => {
    assert.equal(parsePurgeArgs(['--apply', '--apply', '--expect-drafts', '1']).status, 'refused')
    assert.equal(parsePurgeArgs(['--apply', '--expect-drafts', '1', '--expect-drafts', '1']).status, 'refused')
  })

  it('refuses an unknown flag', () => {
    assert.equal(parsePurgeArgs(['--force']).status, 'refused')
    assert.equal(parsePurgeArgs(['--apply', '--expect-drafts', '1', '--yolo']).status, 'refused')
  })
})

// ── formatPurgeReport / isPurgeBlocked ───────────────────────

function sampleReport(overrides: Partial<PurgeReport> = {}): PurgeReport {
  return {
    mode: 'dry_run',
    applied: false,
    draft_count: 6,
    promote_count: 1,
    delete_count: 5,
    blocking: { draft_observed_outcomes_remaining: 0 },
    counts: {
      application_submission_confirmations: 2,
      application_resume_recovery_imports: 1,
      application_outcome_check_observations: 4,
      application_resumes: 3,
      application_evidence_snapshot_entries: 7,
      application_evidence_snapshots: 2,
      application_scores_resume_id_to_null: 1,
    },
    ...overrides,
  }
}

describe('formatPurgeReport / isPurgeBlocked', () => {
  it('reports a clean dry run with no blocking section', () => {
    const report = sampleReport()
    assert.equal(isPurgeBlocked(report), false)
    const text = formatPurgeReport(report)
    assert.match(text, /Mode: dry_run \(no changes made\)/)
    assert.match(text, /drafts to promote.*: 1/)
    assert.match(text, /drafts to delete: 5/)
    assert.match(text, /application_resumes: 3/)
    assert.doesNotMatch(text, /BLOCKED/)
  })

  it('reports an applied purge', () => {
    const text = formatPurgeReport(sampleReport({ mode: 'apply', applied: true }))
    assert.match(text, /Mode: apply \(applied\)/)
    assert.match(text, /^Removed \/ promoted:/m)
  })

  it('surfaces a blocking section exactly when the defensive check is positive', () => {
    const blocked = sampleReport({ blocking: { draft_observed_outcomes_remaining: 1 } })
    assert.equal(isPurgeBlocked(blocked), true)
    assert.match(formatPurgeReport(blocked), /BLOCKED[\s\S]*remaining on a deleted-bound draft: 1/)
  })
})

// ── runApplyDecision ─────────────────────────────────────────

describe('runApplyDecision', () => {
  it('refuses --apply when the storage listing reported an error, WITHOUT calling the DB apply function', async () => {
    let applyRpcCalls = 0
    const applyRpc = async () => {
      applyRpcCalls += 1
      return { data: sampleReport({ mode: 'apply', applied: true }), error: null }
    }
    const preview = sampleReport({ delete_count: 5 })
    const decision = await runApplyDecision(preview, 5, ['resume-artifacts: synthetic list failure'], applyRpc)

    assert.equal(decision.status, 'refused')
    if (decision.status === 'refused') assert.match(decision.reason, /storage listing reported 1 error\(s\)/)
    assert.equal(applyRpcCalls, 0, 'the DB apply function must never be called when the storage listing reported an error')
  })

  it('refuses on every storage list error, not just the first', async () => {
    let applyRpcCalls = 0
    const applyRpc = async () => { applyRpcCalls += 1; return { data: null, error: null } }
    const preview = sampleReport({ delete_count: 5 })
    const decision = await runApplyDecision(preview, 5, ['a: failed', 'a/b: failed'], applyRpc)

    assert.equal(decision.status, 'refused')
    if (decision.status === 'refused') assert.match(decision.reason, /storage listing reported 2 error\(s\)/)
    assert.equal(applyRpcCalls, 0)
  })

  it('refuses on an --expect-drafts mismatch before calling the DB apply function', async () => {
    let applyRpcCalls = 0
    const applyRpc = async () => { applyRpcCalls += 1; return { data: null, error: null } }
    const preview = sampleReport({ delete_count: 5 })
    const decision = await runApplyDecision(preview, 4, [], applyRpc)

    assert.equal(decision.status, 'refused')
    assert.equal(applyRpcCalls, 0)
  })

  it('refuses when the defensive blocking check is positive, before calling the DB apply function', async () => {
    let applyRpcCalls = 0
    const applyRpc = async () => { applyRpcCalls += 1; return { data: null, error: null } }
    const preview = sampleReport({ delete_count: 5, blocking: { draft_observed_outcomes_remaining: 1 } })
    const decision = await runApplyDecision(preview, 5, [], applyRpc)

    assert.equal(decision.status, 'refused')
    assert.equal(applyRpcCalls, 0)
  })

  it('calls the DB apply function and applies once the storage listing is clean and every other check passes', async () => {
    let applyRpcCalls = 0
    const appliedReport = sampleReport({ mode: 'apply', applied: true, delete_count: 5 })
    const applyRpc = async (expectedDrafts: number) => {
      applyRpcCalls += 1
      assert.equal(expectedDrafts, 5)
      return { data: appliedReport, error: null }
    }
    const preview = sampleReport({ delete_count: 5 })
    const decision = await runApplyDecision(preview, 5, [], applyRpc)

    assert.equal(decision.status, 'applied')
    if (decision.status === 'applied') assert.deepEqual(decision.report, appliedReport)
    assert.equal(applyRpcCalls, 1)
  })

  it('surfaces a database refusal from the apply RPC', async () => {
    const applyRpc = async () => ({ data: null, error: { message: 'boom' } })
    const preview = sampleReport({ delete_count: 5 })
    const decision = await runApplyDecision(preview, 5, [], applyRpc)

    assert.equal(decision.status, 'refused')
    if (decision.status === 'refused') assert.match(decision.reason, /Purge refused by the database: boom/)
  })

  it('refuses on an unexpected apply RPC response shape', async () => {
    const applyRpc = async () => ({ data: { not: 'a report' }, error: null })
    const preview = sampleReport({ delete_count: 5 })
    const decision = await runApplyDecision(preview, 5, [], applyRpc)

    assert.equal(decision.status, 'refused')
    if (decision.status === 'refused') assert.match(decision.reason, /Unexpected response shape/)
  })

  // Red-proof: before the fix, a well-shaped but still-dry-run response
  // (mode 'dry_run', applied false) passed PurgeReportSchema.safeParse just
  // fine and was returned as `status: 'applied'` — the caller would then
  // delete every resume-artifacts storage object even though the DB purge
  // never ran. The apply RPC response must report mode 'apply' AND
  // applied === true, or this must refuse before any storage call happens.
  it('refuses when the apply RPC reports a dry-run-shaped response (mode dry_run, applied false), and never lets the caller reach the storage delete step', async () => {
    let applyRpcCalls = 0
    const applyRpc = async () => {
      applyRpcCalls += 1
      return { data: sampleReport({ mode: 'dry_run', applied: false, delete_count: 5 }), error: null }
    }
    const preview = sampleReport({ delete_count: 5 })
    const decision = await runApplyDecision(preview, 5, [], applyRpc)

    assert.equal(decision.status, 'refused')
    if (decision.status === 'refused') assert.match(decision.reason, /did not report an applied purge/)
    assert.equal(applyRpcCalls, 1, 'the apply RPC is still called once — the refusal happens on its response, not before')

    // Mirror the script's own gating (scripts/purge-resume-evidence.ts only
    // calls purgeStorageBucket when decision.status !== 'refused'): prove
    // that gate, with a storage stub that would show the leak if it fired.
    const { storage, removedBatches } = stubStorage({ '': [{ name: 'leaked.pdf', id: 'obj-1' }] })
    if (decision.status !== 'refused') await purgeStorageBucket(storage)
    assert.deepEqual(removedBatches, [], 'storage.remove must never be called when the apply RPC did not actually apply')
  })

  it('refuses when mode is "apply" but applied is false', async () => {
    const applyRpc = async () => ({ data: sampleReport({ mode: 'apply', applied: false, delete_count: 5 }), error: null })
    const preview = sampleReport({ delete_count: 5 })
    const decision = await runApplyDecision(preview, 5, [], applyRpc)

    assert.equal(decision.status, 'refused')
    if (decision.status === 'refused') assert.match(decision.reason, /did not report an applied purge/)
  })

  it('refuses when applied is true but mode is "dry_run" (mismatched shape)', async () => {
    const applyRpc = async () => ({ data: sampleReport({ mode: 'dry_run', applied: true, delete_count: 5 }), error: null })
    const preview = sampleReport({ delete_count: 5 })
    const decision = await runApplyDecision(preview, 5, [], applyRpc)

    assert.equal(decision.status, 'refused')
    if (decision.status === 'refused') assert.match(decision.reason, /did not report an applied purge/)
  })
})

// ── checkPostPurgeResidue / formatPostPurgeWarning ───────────

describe('checkPostPurgeResidue', () => {
  it('reports clean when application_resumes is empty and the bucket is empty', async () => {
    const { storage } = stubStorage({ '': [] })
    const result = await checkPostPurgeResidue(async () => ({ count: 0, error: null }), storage)
    assert.deepEqual(result, { status: 'clean' })
  })

  // Red-proof for the concurrent admin:recover-evidence race: a non-zero
  // application_resumes count after the purge and storage walk must warn
  // and fail, never report success.
  it('warns and reports non-zero when application_resumes has rows remaining', async () => {
    const { storage } = stubStorage({ '': [] })
    const result = await checkPostPurgeResidue(async () => ({ count: 2, error: null }), storage)

    assert.equal(result.status, 'warn')
    if (result.status === 'warn') {
      assert.equal(result.applicationResumesRemaining, 2)
      assert.equal(result.storageObjectsRemaining, 0)
      assert.ok(result.reasons.some(reason => /application_resumes has 2 row\(s\) remaining/.test(reason)))
    }
  })

  it('warns and reports non-zero when resume-artifacts objects remain', async () => {
    const { storage } = stubStorage({ '': [{ name: 'leftover.pdf', id: 'obj-1' }] })
    const result = await checkPostPurgeResidue(async () => ({ count: 0, error: null }), storage)

    assert.equal(result.status, 'warn')
    if (result.status === 'warn') {
      assert.equal(result.applicationResumesRemaining, 0)
      assert.equal(result.storageObjectsRemaining, 1)
      assert.ok(result.reasons.some(reason => /resume-artifacts bucket has 1 object\(s\) remaining/.test(reason)))
    }
  })

  it('warns when both application_resumes rows and storage objects remain', async () => {
    const { storage } = stubStorage({ '': [{ name: 'leftover.pdf', id: 'obj-1' }] })
    const result = await checkPostPurgeResidue(async () => ({ count: 3, error: null }), storage)

    assert.equal(result.status, 'warn')
    if (result.status === 'warn') {
      assert.equal(result.applicationResumesRemaining, 3)
      assert.equal(result.storageObjectsRemaining, 1)
      assert.equal(result.reasons.length, 2)
    }
  })

  it('warns when the application_resumes count query itself fails, rather than assuming clean', async () => {
    const { storage } = stubStorage({ '': [] })
    const result = await checkPostPurgeResidue(async () => ({ count: 0, error: 'connection reset' }), storage)

    assert.equal(result.status, 'warn')
    if (result.status === 'warn') assert.ok(result.reasons.some(reason => /application_resumes count failed: connection reset/.test(reason)))
  })

  it('warns when the storage listing itself reports errors, rather than assuming the bucket is empty', async () => {
    const { storage } = stubStorage({ '': [] }, { failListPath: '' })
    const result = await checkPostPurgeResidue(async () => ({ count: 0, error: null }), storage)

    assert.equal(result.status, 'warn')
    if (result.status === 'warn') assert.ok(result.reasons.some(reason => /resume-artifacts listing reported 1 error\(s\)/.test(reason)))
  })

  it('formatPostPurgeWarning names both counts and warns against running admin:recover-evidence concurrently', () => {
    const text = formatPostPurgeWarning({
      status: 'warn',
      reasons: ['application_resumes has 2 row(s) remaining'],
      applicationResumesRemaining: 2,
      storageObjectsRemaining: 0,
    })
    assert.match(text, /application_resumes rows remaining: 2/)
    assert.match(text, /resume-artifacts storage objects remaining: 0/)
    assert.match(text, /admin:recover-evidence/)
  })
})

// ── purgeStorageBucket ────────────────────────────────────────

// `tree[path]` is the FULL list of entries at that path — list() itself
// slices it per {limit, offset}, exactly like the real paginated Supabase
// storage API, so a tree entry longer than one page forces the production
// pagination loop to actually run (and a bug in it to actually show up).
function stubStorage(tree: Record<string, StorageEntry[]>, options: { failListPath?: string; failRemoveFor?: Set<string> } = {}) {
  const removedBatches: string[][] = []
  const listCalls: Array<{ path: string; limit: number; offset: number }> = []
  return {
    storage: {
      list: async (path: string, listOptions: { limit: number; offset: number }) => {
        listCalls.push({ path, ...listOptions })
        if (options.failListPath === path) return { data: null, error: new Error(`synthetic list failure for ${path}`) }
        const all = tree[path] ?? []
        return { data: all.slice(listOptions.offset, listOptions.offset + listOptions.limit), error: null }
      },
      remove: async (paths: string[]) => {
        removedBatches.push(paths)
        if (options.failRemoveFor && paths.some(path => options.failRemoveFor!.has(path))) {
          return { data: null, error: new Error('synthetic remove failure') }
        }
        return { data: paths, error: null }
      },
    },
    removedBatches,
    listCalls,
  }
}

function syntheticLeaves(count: number, prefix: string): StorageEntry[] {
  return Array.from({ length: count }, (_, i) => ({ name: `${prefix}-${i}.pdf`, id: `obj-${prefix}-${i}` }))
}

describe('purgeStorageBucket', () => {
  it('recurses into folders (id: null entries) and removes every leaf object', async () => {
    const { storage, removedBatches } = stubStorage({
      '': [{ name: 'app-1', id: null }, { name: 'app-2', id: null }],
      'app-1': [{ name: 'resume-1', id: null }],
      'app-1/resume-1': [{ name: 'resume.docx', id: 'obj-1' }, { name: 'resume.pdf', id: 'obj-2' }],
      'app-2': [{ name: 'resume-2', id: null }],
      'app-2/resume-2': [{ name: 'resume.pdf', id: 'obj-3' }],
    })
    const result = await purgeStorageBucket(storage)
    assert.equal(result.listed, 3)
    assert.equal(result.removed, 3)
    assert.deepEqual(result.failed, [])
    assert.deepEqual(removedBatches.flat().sort(), [
      'app-1/resume-1/resume.docx',
      'app-1/resume-1/resume.pdf',
      'app-2/resume-2/resume.pdf',
    ])
  })

  it('reports an empty bucket as zero listed/removed, not an error', async () => {
    const { storage } = stubStorage({ '': [] })
    assert.deepEqual(await purgeStorageBucket(storage), { listed: 0, removed: 0, failed: [] })
  })

  it('records a list failure without throwing, and still removes what it did find', async () => {
    const { storage } = stubStorage({
      '': [{ name: 'app-1', id: null }, { name: 'app-2', id: null }],
      'app-1': [{ name: 'resume.docx', id: 'obj-1' }],
      // 'app-2' deliberately missing from the tree so its list() call fails below.
    }, { failListPath: 'app-2' })
    const result = await purgeStorageBucket(storage)
    assert.equal(result.listed, 1)
    assert.equal(result.removed, 1)
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0], /^app-2:/)
  })

  it('records a remove failure without throwing, and reports every path in the failing batch', async () => {
    const { storage } = stubStorage({
      '': [{ name: 'ok.docx', id: 'obj-1' }, { name: 'bad.docx', id: 'obj-2' }],
    }, { failRemoveFor: new Set(['bad.docx']) })
    // Both paths land in the same (small) batch since REMOVE_BATCH_SIZE is
    // 100 — one failing path fails the whole batch's report, by design: the
    // Supabase remove() API does not report per-path outcomes within a batch.
    const result = await purgeStorageBucket(storage)
    assert.equal(result.listed, 2)
    assert.equal(result.removed, 0)
    assert.equal(result.failed.length, 2)
  })

  it('catches a thrown list()/remove() rejection as a reported failure, not an unhandled rejection', async () => {
    const result = await purgeStorageBucket({
      list: async () => { throw new Error('synthetic list rejection') },
      remove: async () => ({ data: null, error: null }),
    })
    assert.equal(result.listed, 0)
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0], /synthetic list rejection/)
  })

  // Red-proof for the pagination bug: before the fix, list() was called
  // with no {limit, offset} at all, so the client's own default (100)
  // silently capped every page at 100 and the walk stopped there — both
  // here and in the dry-run count — with no error of any kind. A tree path
  // with exactly 150 entries (more than one page, not a clean multiple)
  // forces at least two list() calls per level or this fails.
  it('paginates past a 100-entry page at the bucket ROOT instead of silently stopping at 100', async () => {
    const { storage, listCalls } = stubStorage({ '': syntheticLeaves(150, 'root') })
    const result = await purgeStorageBucket(storage)
    assert.equal(result.listed, 150, 'must collect every object across pages, not just the first 100')
    assert.equal(result.removed, 150)
    const rootCalls = listCalls.filter(call => call.path === '')
    assert.ok(rootCalls.length >= 2, 'must have made at least two list() calls at the root to cross the page boundary')
    assert.deepEqual(rootCalls.map(call => call.offset).sort((a, b) => a - b), [0, 100])
  })

  it('paginates past a 100-entry page INSIDE a nested folder, not only at the root', async () => {
    const { storage, listCalls } = stubStorage({
      '': [{ name: 'big-app', id: null }],
      'big-app': syntheticLeaves(150, 'nested'),
    })
    const result = await purgeStorageBucket(storage)
    assert.equal(result.listed, 150, 'must collect every object in the folder across pages, not just the first 100')
    assert.equal(result.removed, 150)
    const nestedCalls = listCalls.filter(call => call.path === 'big-app')
    assert.ok(nestedCalls.length >= 2, 'must have paginated inside the folder, not just at the root')
    assert.deepEqual(nestedCalls.map(call => call.offset).sort((a, b) => a - b), [0, 100])
  })

  it('still stops after exactly one page when a path has fewer entries than the page size', async () => {
    const { storage, listCalls } = stubStorage({ '': syntheticLeaves(5, 'small') })
    await purgeStorageBucket(storage)
    assert.equal(listCalls.filter(call => call.path === '').length, 1, 'a short first page must not trigger a second, empty call')
  })
})

describe('countStorageBucketObjects', () => {
  it('counts recursively without calling remove (the dry-run report never deletes)', async () => {
    let removeCalled = false
    const { storage } = stubStorage({
      '': [{ name: 'app-1', id: null }],
      'app-1': [{ name: 'resume-1', id: null }],
      'app-1/resume-1': [{ name: 'resume.docx', id: 'obj-1' }, { name: 'resume.pdf', id: 'obj-2' }],
    })
    const result = await countStorageBucketObjects({
      list: storage.list,
      remove: async (paths: string[]) => { removeCalled = true; return storage.remove(paths) },
    })
    assert.equal(result.count, 2)
    assert.deepEqual(result.listErrors, [])
    assert.equal(removeCalled, false)
  })

  // Same red-proof as purgeStorageBucket's pagination tests: the dry-run
  // report must not undercount a bucket with more than one page of objects
  // at either the root or inside a folder.
  it('paginates past a 100-entry page at the root when counting (never undercounts the dry run)', async () => {
    const { storage } = stubStorage({ '': syntheticLeaves(150, 'root') })
    const result = await countStorageBucketObjects(storage)
    assert.equal(result.count, 150)
  })

  it('paginates past a 100-entry page inside a nested folder when counting', async () => {
    const { storage } = stubStorage({
      '': [{ name: 'big-app', id: null }],
      'big-app': syntheticLeaves(150, 'nested'),
    })
    const result = await countStorageBucketObjects(storage)
    assert.equal(result.count, 150)
  })

  it('surfaces a list failure as an error without throwing', async () => {
    const { storage } = stubStorage({ '': [] }, { failListPath: '' })
    const result = await countStorageBucketObjects(storage)
    assert.equal(result.count, 0)
    assert.equal(result.listErrors.length, 1)
  })
})

// ── purge_resume_evidence() — real migration under PGlite ───

const baseline = readFileSync('supabase/migrations/20260329000000_job_hunt_pipeline.sql', 'utf8')
  .replace(/^create extension if not exists pg_trgm;$/m, '')
  .replace(/^create index .*gin_trgm_ops.*;$/gm, '')
const evidenceBundleMigration = readFileSync('supabase/migrations/20260913000000_application_evidence_bundle.sql', 'utf8')
const confirmationMigration = readFileSync('supabase/migrations/20260913000002_application_submission_confirmation.sql', 'utf8')
const snapshotMigration = readFileSync('supabase/migrations/20260914000000_application_evidence_snapshot.sql', 'utf8')
  .replace("encode(pg_catalog.sha256(pg_catalog.convert_to(new.job_description, 'UTF8')), 'hex')", "repeat(md5(new.job_description), 2)")
  .replaceAll("encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text, 'UTF8')), 'hex')", "repeat(md5(v_payload::text), 2)")
const recoveryMigration = readFileSync('supabase/migrations/20260915000000_application_evidence_recovery.sql', 'utf8')
  .replaceAll("encode(pg_catalog.sha256(pg_catalog.convert_to(p_resume_content::text, 'UTF8')), 'hex')", "repeat(md5(p_resume_content::text), 2)")
  .replaceAll("encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text, 'UTF8')), 'hex')", "repeat(md5(v_payload::text), 2)")
const retentionMigration = readFileSync('supabase/migrations/20260919000000_application_evidence_snapshot_retention.sql', 'utf8')
const purgeMigration = readFileSync('supabase/migrations/20261002120000_purge_resume_evidence.sql', 'utf8')

const db = new PGlite()

type Report = {
  mode: 'dry_run' | 'apply'
  applied: boolean
  draft_count: number
  promote_count: number
  delete_count: number
  blocking: { draft_observed_outcomes_remaining: number }
  counts: Record<string, number>
}

async function dryRun(): Promise<Report> {
  const result = await db.query<{ report: Report }>('select public.purge_resume_evidence() as report')
  return result.rows[0].report
}

async function apply(expectedDraftsToDelete: number): Promise<Report> {
  const result = await db.query<{ report: Report }>(
    'select public.purge_resume_evidence(true, $1::integer) as report',
    [expectedDraftsToDelete],
  )
  return result.rows[0].report
}

async function insertDraft(label: string): Promise<{ applicationId: string; resumeId: string }> {
  const application = await db.query<{ id: string }>(
    "insert into job_applications(company, role, stage) values ($1, 'Senior TypeScript Engineer', 'draft') returning id",
    [label],
  )
  const applicationId = application.rows[0].id
  await db.query(
    "insert into application_stages(application_id, stage, note) values ($1, 'draft', 'tailored')",
    [applicationId],
  )
  const resume = await db.query<{ id: string }>(
    'insert into application_resumes(application_id, resume_content, is_submitted) values ($1, $2::jsonb, false) returning id',
    [applicationId, JSON.stringify({ summary: `${label} draft resume` })],
  )
  return { applicationId, resumeId: resume.rows[0].id }
}

async function insertApplied(label: string): Promise<{ applicationId: string; resumeId: string }> {
  const application = await db.query<{ id: string }>(
    "insert into job_applications(company, role, stage) values ($1, 'Senior TypeScript Engineer', 'applied') returning id",
    [label],
  )
  const applicationId = application.rows[0].id
  await db.query(
    "insert into application_stages(application_id, stage, note) values ($1, 'applied', 'submitted')",
    [applicationId],
  )
  const resume = await db.query<{ id: string }>(
    'insert into application_resumes(application_id, resume_content, is_submitted) values ($1, $2::jsonb, true) returning id',
    [applicationId, JSON.stringify({ summary: `${label} submitted resume` })],
  )
  await db.query(
    "insert into application_scores(application_id, resume_id, score_type, score) values ($1, $2, 'jd_fit', 80)",
    [applicationId, resume.rows[0].id],
  )
  return { applicationId, resumeId: resume.rows[0].id }
}

let observedOutcomeSerial = 0
async function insertObservedOutcome(applicationId: string): Promise<void> {
  observedOutcomeSerial += 1
  const sourceEventId = `imap:${'a'.repeat(64)}:1:${observedOutcomeSerial}`
  await db.query(
    `insert into application_observed_outcomes
       (application_id, source_identity, source_event_id, revision, event_type, source_ref, evidence_hash, classification_code, canonical_payload, payload_hash)
     values ($1, 'granted_inbox', $2, 1, 'recruiter_contact', $2, $3, 'unclassified', '{}'::jsonb, $3)`,
    [applicationId, sourceEventId, 'd'.repeat(64)],
  )
}

let outcomeCheckSerial = 0
async function insertOutcomeCheck(applicationId: string): Promise<void> {
  outcomeCheckSerial += 1
  await db.query(
    `insert into application_outcome_check_observations
       (application_id, reader_channel, client_check_identity, period_start, period_end, query_scope, complete, status, matched_uid_count, drained_uid_count, source_ref, canonical_payload, payload_hash)
     values ($1, 'imap_inbox', $2, now() - interval '1 day', now(), 'inbox_internaldate_v1', true, 'no_response', 0, 0, $3, '{}'::jsonb, $4)`,
    [applicationId, `check-${outcomeCheckSerial}`, `imap-coverage:${'b'.repeat(64)}:1:0:0:0`, 'c'.repeat(64)],
  )
}

async function insertConfirmation(applicationId: string, resumeId: string): Promise<void> {
  await db.query(
    "insert into application_submission_confirmations(application_id, resume_id, confirmation_source) values ($1, $2, 'unknown')",
    [applicationId, resumeId],
  )
}

async function insertRecoveryImport(applicationId: string, resumeId: string): Promise<void> {
  await db.query(
    `insert into application_resume_recovery_imports
       (recovery_id, application_id, resume_id, source_ref, resume_content_hash, docx_url, docx_hash, payload_hash)
     values (gen_random_uuid(), $1, $2, 'job-hunt-agent:output:fixture.json', $3, 'owned/doc.docx', $4, $5)`,
    [applicationId, resumeId, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
  )
}

/** Inserts a materialized snapshot directly (not via create_application_evidence_snapshot())
 *  — this suite only needs rows to exist for the purge's own delete logic to
 *  be exercised; snapshot materialization itself is already covered in
 *  tests/application-evidence-snapshot.test.ts. */
async function insertSnapshot(entryCount: number): Promise<{ snapshotId: string }> {
  const snapshot = await db.query<{ id: string }>(
    "insert into application_evidence_snapshots(as_of, total_applications) values (now(), $1) returning id",
    [entryCount],
  )
  const snapshotId = snapshot.rows[0].id
  for (let ordinal = 1; ordinal <= entryCount; ordinal++) {
    await db.query(
      'insert into application_evidence_snapshot_entries(snapshot_id, ordinal, application_id, evidence) values ($1, $2, gen_random_uuid(), $3::jsonb)',
      [snapshotId, ordinal, JSON.stringify({ synthetic: true })],
    )
  }
  return { snapshotId }
}

before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.role() returns text language sql as $$ select current_user::text $$;")
  await db.exec('create schema storage; create table storage.buckets (id text primary key, name text, public boolean); create table storage.objects (bucket_id text);')
  await db.exec(baseline)
  await db.exec(evidenceBundleMigration)
  await db.exec(confirmationMigration)
  await db.exec(snapshotMigration)
  await db.exec(recoveryMigration)
  await db.exec(retentionMigration)
  await db.exec(purgeMigration)
})
after(() => db.close())

describe('purge_resume_evidence() SQL function', () => {
  it('dry run counts a plain draft and an applied application without changing anything', async () => {
    const beforeCounts = await dryRun()
    const draft = await insertDraft('dry-run-draft')
    const applied = await insertApplied('dry-run-applied')

    const afterInsert = await dryRun()
    assert.equal(afterInsert.applied, false)
    assert.equal(afterInsert.draft_count, beforeCounts.draft_count + 1)
    assert.equal(afterInsert.promote_count, beforeCounts.promote_count, 'a plain draft with no observed outcome is never promoted')
    assert.equal(afterInsert.delete_count, beforeCounts.delete_count + 1)
    assert.equal(afterInsert.counts.application_resumes, beforeCounts.counts.application_resumes + 2)
    assert.equal(afterInsert.counts.application_scores_resume_id_to_null, beforeCounts.counts.application_scores_resume_id_to_null + 1)
    assert.deepEqual(afterInsert.blocking, { draft_observed_outcomes_remaining: 0 })

    // Nothing changed.
    const stillThere = await db.query('select id from job_applications where id = any($1::uuid[])', [[draft.applicationId, applied.applicationId]])
    assert.equal(stillThere.rows.length, 2)

    await db.query('delete from job_applications where id = any($1::uuid[])', [[draft.applicationId, applied.applicationId]])
  })

  it('a draft with an observed outcome counts toward promote_count, not delete_count', async () => {
    const beforeCounts = await dryRun()
    const draft = await insertDraft('promote-counts-draft')
    await insertObservedOutcome(draft.applicationId)

    const afterInsert = await dryRun()
    assert.equal(afterInsert.draft_count, beforeCounts.draft_count + 1)
    assert.equal(afterInsert.promote_count, beforeCounts.promote_count + 1)
    assert.equal(afterInsert.delete_count, beforeCounts.delete_count, 'a promoted draft must not also count toward delete_count')
    assert.deepEqual(afterInsert.blocking, { draft_observed_outcomes_remaining: 0 })

    await db.query('delete from application_observed_outcomes where application_id = $1', [draft.applicationId])
    await db.query('delete from job_applications where id = $1', [draft.applicationId])
  })

  it('refuses to apply when --expect-drafts does not match the "drafts to delete" count', async () => {
    const draft = await insertDraft('mismatch-draft')
    const current = await dryRun()
    await assert.rejects(apply(current.delete_count + 1), /Draft-to-delete count mismatch/)

    const stillThere = await db.query('select id from job_applications where id = $1', [draft.applicationId])
    assert.equal(stillThere.rows.length, 1, 'a rejected apply call must not delete anything')

    await db.query('delete from job_applications where id = $1', [draft.applicationId])
  })

  it('refuses to apply when --expect-drafts is the raw draft_count instead of delete_count, while a promotion is pending', async () => {
    const draft = await insertDraft('raw-count-draft')
    await insertObservedOutcome(draft.applicationId)
    const preview = await dryRun()
    assert.ok(preview.draft_count > preview.delete_count, 'fixture must actually have something pending promotion')

    await assert.rejects(apply(preview.draft_count), /Draft-to-delete count mismatch/)

    const stillThere = await db.query("select stage from job_applications where id = $1", [draft.applicationId])
    assert.equal(stillThere.rows[0].stage, 'draft', 'a rejected apply call must not promote or delete anything')

    await db.query('delete from application_observed_outcomes where application_id = $1', [draft.applicationId])
    await db.query('delete from job_applications where id = $1', [draft.applicationId])
  })

  it('deletes every application_submission_confirmations row (resume evidence, no longer blocking)', async () => {
    const applied = await insertApplied('confirmation-deleted-applied')
    await insertConfirmation(applied.applicationId, applied.resumeId)

    const preview = await dryRun()
    assert.ok(preview.counts.application_submission_confirmations >= 1)
    assert.deepEqual(preview.blocking, { draft_observed_outcomes_remaining: 0 }, 'a confirmation must never block the run')

    const result = await apply(preview.delete_count)
    assert.equal(result.counts.application_submission_confirmations, preview.counts.application_submission_confirmations)

    const confirmationsLeft = await db.query('select count(*)::int as count from application_submission_confirmations where application_id = $1', [applied.applicationId])
    assert.equal(confirmationsLeft.rows[0].count, 0)
    const resumesLeft = await db.query('select count(*)::int as count from application_resumes where id = $1', [applied.resumeId])
    assert.equal(resumesLeft.rows[0].count, 0, 'the composite CASCADE FK must not have blocked the confirmation delete or the resume delete')

    await db.query('delete from job_applications where id = $1', [applied.applicationId])
  })

  it('promotes a draft with an observed outcome to applied instead of deleting it; its outcomes/outcome-checks and resume are otherwise handled correctly', async () => {
    const draft = await insertDraft('promoted-draft')
    await insertObservedOutcome(draft.applicationId)
    await insertOutcomeCheck(draft.applicationId) // must survive — attached to a PROMOTED application, not a deleted one
    const beforePromotion = await db.query<{ applied_at: string }>('select applied_at from job_applications where id = $1', [draft.applicationId])
    const appliedAtBefore = beforePromotion.rows[0].applied_at

    const preview = await dryRun()
    const result = await apply(preview.delete_count)
    assert.equal(result.promote_count, 1)

    const row = await db.query<{ stage: string; applied_at: string }>('select stage, applied_at from job_applications where id = $1', [draft.applicationId])
    assert.equal(row.rows[0].stage, 'applied', 'a draft with a recorded reply must be promoted, not deleted')
    assert.equal(new Date(row.rows[0].applied_at).getTime(), new Date(appliedAtBefore).getTime(), 'promotion must change stage only — applied_at stays exactly as it was')

    const stageHistory = await db.query<{ stage: string; note: string | null }>(
      'select stage, note from application_stages where application_id = $1 order by occurred_at',
      [draft.applicationId],
    )
    assert.deepEqual(stageHistory.rows.map(r => r.stage), ['draft', 'applied'], 'the original draft history stays; one applied row is appended')
    assert.match(stageHistory.rows[1].note ?? '', /Promoted from draft/)

    const outcomesLeft = await db.query('select count(*)::int as count from application_observed_outcomes where application_id = $1', [draft.applicationId])
    assert.equal(outcomesLeft.rows[0].count, 1, 'a promoted application keeps its observed outcomes')
    const outcomeChecksLeft = await db.query('select count(*)::int as count from application_outcome_check_observations where application_id = $1', [draft.applicationId])
    assert.equal(outcomeChecksLeft.rows[0].count, 1, 'a promoted application keeps its outcome-check rows too')

    // Resume evidence is still wiped for a promoted application, same as any other.
    const resumesLeft = await db.query('select count(*)::int as count from application_resumes where application_id = $1', [draft.applicationId])
    assert.equal(resumesLeft.rows[0].count, 0)

    await db.query('delete from application_outcome_check_observations where application_id = $1', [draft.applicationId])
    await db.query('delete from application_observed_outcomes where application_id = $1', [draft.applicationId])
    await db.query('delete from job_applications where id = $1', [draft.applicationId])
  })

  it('deletes outcome-check rows attached to a draft being deleted, letting the RESTRICT-guarded draft delete through', async () => {
    const draft = await insertDraft('outcome-check-deleted-draft')
    await insertOutcomeCheck(draft.applicationId)
    await insertOutcomeCheck(draft.applicationId)

    const preview = await dryRun()
    assert.ok(preview.counts.application_outcome_check_observations >= 2)

    const result = await apply(preview.delete_count)
    assert.equal(result.counts.application_outcome_check_observations, preview.counts.application_outcome_check_observations)

    const draftLeft = await db.query('select id from job_applications where id = $1', [draft.applicationId])
    assert.equal(draftLeft.rows.length, 0, 'the RESTRICT FK must not have blocked the draft delete once its outcome-checks were removed first')
    const checksLeft = await db.query('select count(*)::int as count from application_outcome_check_observations where application_id = $1', [draft.applicationId])
    assert.equal(checksLeft.rows[0].count, 0)
  })

  it('deletes every materialized evidence snapshot and its entries, entries before their parent', async () => {
    await insertSnapshot(3)
    await insertSnapshot(2)

    const preview = await dryRun()
    assert.ok(preview.counts.application_evidence_snapshots >= 2)
    assert.ok(preview.counts.application_evidence_snapshot_entries >= 5)

    const result = await apply(preview.delete_count)
    assert.equal(result.counts.application_evidence_snapshots, preview.counts.application_evidence_snapshots)
    assert.equal(result.counts.application_evidence_snapshot_entries, preview.counts.application_evidence_snapshot_entries)

    const snapshotsLeft = await db.query('select count(*)::int as count from application_evidence_snapshots')
    assert.equal(snapshotsLeft.rows[0].count, 0)
    const entriesLeft = await db.query('select count(*)::int as count from application_evidence_snapshot_entries')
    assert.equal(entriesLeft.rows[0].count, 0)
  })

  it('applies the purge end to end: recovery imports, confirmations, resumes, and snapshots all go; applied applications, their history, and nulled scores survive', async () => {
    const draft = await insertDraft('apply-draft')
    const applied = await insertApplied('apply-applied')
    await insertRecoveryImport(applied.applicationId, applied.resumeId)
    await insertSnapshot(2)

    const preview = await dryRun()
    assert.deepEqual(preview.blocking, { draft_observed_outcomes_remaining: 0 })
    assert.ok(preview.delete_count >= 1)
    assert.ok(preview.counts.application_evidence_snapshots >= 1)

    const result = await apply(preview.delete_count)
    assert.equal(result.mode, 'apply')
    assert.equal(result.applied, true)
    assert.equal(result.counts.application_resumes, preview.counts.application_resumes)
    assert.equal(result.counts.application_resume_recovery_imports, preview.counts.application_resume_recovery_imports)
    assert.equal(result.counts.application_evidence_snapshots, preview.counts.application_evidence_snapshots)
    assert.equal(result.counts.application_evidence_snapshot_entries, preview.counts.application_evidence_snapshot_entries)
    assert.equal(result.delete_count, preview.delete_count)

    const resumesLeft = await db.query('select count(*)::int as count from application_resumes')
    assert.equal(resumesLeft.rows[0].count, 0)
    const recoveryImportsLeft = await db.query('select count(*)::int as count from application_resume_recovery_imports')
    assert.equal(recoveryImportsLeft.rows[0].count, 0)
    const snapshotsLeft = await db.query('select count(*)::int as count from application_evidence_snapshots')
    assert.equal(snapshotsLeft.rows[0].count, 0)
    const entriesLeft = await db.query('select count(*)::int as count from application_evidence_snapshot_entries')
    assert.equal(entriesLeft.rows[0].count, 0)
    const draftsLeft = await db.query("select count(*)::int as count from job_applications where stage = 'draft'")
    assert.equal(draftsLeft.rows[0].count, 0)
    const draftStageHistoryLeft = await db.query('select count(*)::int as count from application_stages where application_id = $1', [draft.applicationId])
    assert.equal(draftStageHistoryLeft.rows[0].count, 0)
    // This purge never touches application tables for a reason unrelated to
    // drafts/resumes: deleting snapshots must not cascade or restrict into
    // job_applications at all. Confirmed above (applied's own row, checked
    // next, is untouched) and by the migration header's FK audit.

    // The applied application itself, its stage history, and its score row
    // (kept, but with resume_id nulled) all survive.
    const appliedRow = await db.query('select stage from job_applications where id = $1', [applied.applicationId])
    assert.equal(appliedRow.rows[0].stage, 'applied')
    const appliedStageHistory = await db.query('select count(*)::int as count from application_stages where application_id = $1', [applied.applicationId])
    assert.equal(appliedStageHistory.rows[0].count, 1)
    const appliedScore = await db.query('select resume_id from application_scores where application_id = $1', [applied.applicationId])
    assert.equal(appliedScore.rows.length, 1)
    assert.equal(appliedScore.rows[0].resume_id, null)
  })

  it('a second apply call with the now-current (zero) drafts-to-delete count is a safe no-op', async () => {
    const result = await apply(0)
    assert.equal(result.delete_count, 0)
    assert.equal(result.counts.application_resumes, 0)
  })

  it('grants: only service_role may execute purge_resume_evidence, and the generic audit query does not flag it', async () => {
    for (const role of ['anon', 'authenticated']) {
      const privilege = await db.query<{ allowed: boolean }>(
        "select has_function_privilege($1, 'public.purge_resume_evidence(boolean,integer)', 'execute') as allowed",
        [role],
      )
      assert.equal(privilege.rows[0].allowed, false)
    }
    const servicePrivilege = await db.query<{ allowed: boolean }>(
      "select has_function_privilege('service_role', 'public.purge_resume_evidence(boolean,integer)', 'execute') as allowed",
    )
    assert.equal(servicePrivilege.rows[0].allowed, true)

    const exposed = await db.query<{ signature: string }>(SECURITY_DEFINER_GRANTS_QUERY)
    assert.ok(!exposed.rows.some(row => row.signature.startsWith('purge_resume_evidence(')))
  })
})
