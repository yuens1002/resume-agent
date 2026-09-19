/**
 * Retention for application evidence snapshots (#285).
 *
 * Runs the production migrations under PGlite, using the same setup as
 * tests/application-evidence-snapshot.test.ts, then applies
 * 20260919000000_application_evidence_snapshot_retention.sql unchanged.
 *
 * The retention window is never restated here. Every age this file constructs
 * is computed in SQL from public.application_evidence_snapshot_retention(), so
 * changing the window's value in the migration cannot make these tests lie.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { getApplicationEvidenceSnapshotPage } from '../src/lib/application-evidence-snapshot.js'
import { SECURITY_DEFINER_GRANTS_QUERY } from '../scripts/check-security-definer-grants.js'

const RETENTION_FUNCTION_NAME = 'application_evidence_snapshot_retention'
const PRUNE_BATCH_FUNCTION_NAME = 'application_evidence_snapshot_prune_batch'
const RETENTION_MIGRATION_PATH = 'supabase/migrations/20260919000000_application_evidence_snapshot_retention.sql'

const baseline = readFileSync('supabase/migrations/20260329000000_job_hunt_pipeline.sql', 'utf8')
  .replace(/^create extension if not exists pg_trgm;$/m, '')
  .replace(/^create index .*gin_trgm_ops.*;$/gm, '')
const evidenceBundleMigration = readFileSync('supabase/migrations/20260913000000_application_evidence_bundle.sql', 'utf8')
const confirmationMigration = readFileSync('supabase/migrations/20260913000002_application_submission_confirmation.sql', 'utf8')
// PGlite does not expose PostgreSQL 16's pg_catalog.sha256(bytea); these
// substitutions match tests/application-evidence-snapshot.test.ts exactly.
const snapshotMigration = readFileSync('supabase/migrations/20260914000000_application_evidence_snapshot.sql', 'utf8')
  .replace("encode(pg_catalog.sha256(pg_catalog.convert_to(new.job_description, 'UTF8')), 'hex')", "repeat(md5(new.job_description), 2)")
  .replaceAll("encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text, 'UTF8')), 'hex')", "repeat(md5(v_payload::text), 2)")
const recoveryMigration = readFileSync('supabase/migrations/20260915000000_application_evidence_recovery.sql', 'utf8')
  .replaceAll("encode(pg_catalog.sha256(pg_catalog.convert_to(p_resume_content::text, 'UTF8')), 'hex')", "repeat(md5(p_resume_content::text), 2)")
  .replaceAll("encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text, 'UTF8')), 'hex')", "repeat(md5(v_payload::text), 2)")
// Applied byte-for-byte: the retention migration has no engine-specific calls.
const retentionMigration = readFileSync(RETENTION_MIGRATION_PATH, 'utf8')

const db = new PGlite()

type SnapshotMetadata = { snapshot_id: string; as_of: string; total_applications: number; snapshot_materialized: true }
type SnapshotPage = {
  snapshot: SnapshotMetadata
  applications: Array<{ application: { application_id: string } }>
  next_cursor: { ordinal: number } | null
  is_final_page: boolean
}

async function createSnapshot(): Promise<SnapshotMetadata> {
  const result = await db.query<{ snapshot: SnapshotMetadata }>('select public.create_application_evidence_snapshot() as snapshot')
  return result.rows[0].snapshot
}

async function getPage(snapshotId: string, afterOrdinal: number | null, limit: number): Promise<SnapshotPage> {
  const result = await db.query<{ page: SnapshotPage }>(
    'select public.get_application_evidence_snapshot_page($1::uuid, $2::integer, $3::integer) as page',
    [snapshotId, afterOrdinal, limit],
  )
  return result.rows[0].page
}

/** Moves a snapshot's creation time to the retention boundary plus `offsetFromBoundary`
 *  (a SQL interval: negative is older than the window, positive is inside it). */
async function ageSnapshotRelativeToRetention(snapshotId: string, offsetFromBoundary: string): Promise<void> {
  await db.query(
    `update public.application_evidence_snapshots
     set created_at = now() - public.${RETENTION_FUNCTION_NAME}() + $2::interval
     where id = $1::uuid`,
    [snapshotId, offsetFromBoundary],
  )
}

async function snapshotExists(snapshotId: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    'select exists (select 1 from public.application_evidence_snapshots where id = $1::uuid) as present',
    [snapshotId],
  )
  return result.rows[0].present
}

async function entryCount(snapshotId: string): Promise<number> {
  const result = await db.query<{ entries: number }>(
    'select count(*)::integer as entries from public.application_evidence_snapshot_entries where snapshot_id = $1::uuid',
    [snapshotId],
  )
  return result.rows[0].entries
}

async function orphanEntryCount(): Promise<number> {
  const result = await db.query<{ orphans: number }>(`
    select count(*)::integer as orphans
    from public.application_evidence_snapshot_entries entry
    left join public.application_evidence_snapshots snapshot on snapshot.id = entry.snapshot_id
    where snapshot.id is null`)
  return result.rows[0].orphans
}

/** Pages a snapshot end to end and returns the application IDs it yielded, in ordinal order. */
async function pageAllApplicationIds(snapshotId: string, limit: number): Promise<string[]> {
  const collected: string[] = []
  let afterOrdinal: number | null = null
  for (;;) {
    const page = await getPage(snapshotId, afterOrdinal, limit)
    collected.push(...page.applications.map(entry => entry.application.application_id))
    if (page.is_final_page) {
      assert.equal(page.next_cursor, null)
      return collected
    }
    assert.ok(page.next_cursor, 'a non-final page must carry a cursor')
    afterOrdinal = page.next_cursor.ordinal
  }
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
  for (const company of ['retention alpha', 'retention beta', 'retention gamma', 'retention delta', 'retention epsilon']) {
    await db.query("insert into job_applications(company, role, stage) values ($1, 'retention role', 'applied')", [company])
  }
})
after(() => db.close())

describe('application evidence snapshot retention', () => {
  it('defines the retention window exactly once, as a positive interval the creator reads by name', async () => {
    const definitionPattern = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${RETENTION_FUNCTION_NAME}\\s*\\(`, 'gi')
    const definingMigrations = readdirSync('supabase/migrations')
      .filter(file => file.endsWith('.sql'))
      .flatMap(file => {
        const matches = readFileSync(`supabase/migrations/${file}`, 'utf8').match(definitionPattern) ?? []
        return matches.map(() => file)
      })
    assert.deepEqual(definingMigrations, [RETENTION_MIGRATION_PATH.split('/').pop()])

    const creatorBody = retentionMigration.match(
      /create or replace function public\.create_application_evidence_snapshot\(\)[\s\S]*?\n\$\$;/,
    )?.[0]
    assert.ok(creatorBody, 'the retention migration must redefine the snapshot creator')
    assert.match(creatorBody, new RegExp(`public\\.${RETENTION_FUNCTION_NAME}\\(\\)`))
    assert.doesNotMatch(creatorBody, /interval\s+'/i, 'the creator must not restate the window as a literal')

    const window = await db.query<{ positive: boolean }>(
      `select public.${RETENTION_FUNCTION_NAME}() > interval '0' as positive`,
    )
    assert.equal(window.rows[0].positive, true)
  })

  it('prunes snapshots older than the window on create, keeps in-window snapshots whole, and leaves no orphan entries', async () => {
    const expired = await createSnapshot()
    const justInside = await createSnapshot()
    const recent = await createSnapshot()
    await ageSnapshotRelativeToRetention(expired.snapshot_id, '-1 second')
    await ageSnapshotRelativeToRetention(justInside.snapshot_id, '1 minute')
    assert.ok(await entryCount(expired.snapshot_id) > 0, 'fixture: the expired snapshot starts with entries')

    const created = await createSnapshot()

    assert.equal(await snapshotExists(expired.snapshot_id), false)
    assert.equal(await entryCount(expired.snapshot_id), 0)
    assert.equal(await orphanEntryCount(), 0)
    for (const kept of [justInside, recent, created]) {
      assert.equal(await snapshotExists(kept.snapshot_id), true)
      assert.equal(await entryCount(kept.snapshot_id), kept.total_applications)
    }

    const stale = await db.query<{ stale: number }>(
      `select count(*)::integer as stale from public.application_evidence_snapshots
       where created_at < now() - public.${RETENTION_FUNCTION_NAME}()`,
    )
    assert.equal(stale.rows[0].stale, 0)
  })

  it('prunes at most one batch per create and drains a backlog over the next calls', async () => {
    const batch = (await db.query<{ size: number }>(
      `select public.${PRUNE_BATCH_FUNCTION_NAME}()::integer as size`,
    )).rows[0].size
    assert.ok(batch > 0, 'fixture: the batch bound must be positive')

    // Create the whole backlog first: each create prunes, so ageing as we go
    // would let the loop drain its own backlog before the measured call.
    const backlog: string[] = []
    for (let index = 0; index < batch + 2; index += 1) backlog.push((await createSnapshot()).snapshot_id)
    // Oldest first, so the prune order is observable.
    for (const [index, id] of backlog.entries()) await ageSnapshotRelativeToRetention(id, `-${batch + 2 - index} hours`)

    await createSnapshot()
    const survivors = []
    for (const id of backlog) if (await snapshotExists(id)) survivors.push(id)
    assert.equal(survivors.length, 2, 'one create prunes exactly one batch, not the whole backlog')
    assert.deepEqual(survivors, backlog.slice(batch), 'the oldest expired snapshots go first')

    await createSnapshot()
    for (const id of backlog) assert.equal(await snapshotExists(id), false, 'the backlog drains over the next calls')
    assert.equal(await orphanEntryCount(), 0)
  })

  it('pages an in-window snapshot end to end, every ordinal exactly once, after a later create has pruned', async () => {
    const snapshot = await createSnapshot()
    await ageSnapshotRelativeToRetention(snapshot.snapshot_id, '1 minute')
    const expired = await createSnapshot()
    await ageSnapshotRelativeToRetention(expired.snapshot_id, '-1 hour')

    const firstPage = await getPage(snapshot.snapshot_id, null, 2)
    assert.equal(firstPage.is_final_page, false)
    await createSnapshot()
    assert.equal(await snapshotExists(expired.snapshot_id), false, 'fixture: the later create must actually have pruned')

    const applicationIds = await pageAllApplicationIds(snapshot.snapshot_id, 2)
    assert.equal(applicationIds.length, snapshot.total_applications)
    assert.equal(new Set(applicationIds).size, snapshot.total_applications)
    const expected = await db.query<{ application_id: string }>(
      'select application_id from public.application_evidence_snapshot_entries where snapshot_id = $1::uuid order by ordinal',
      [snapshot.snapshot_id],
    )
    assert.deepEqual(applicationIds, expected.rows.map(row => row.application_id))
  })

  it('refuses a pruned snapshot ID with P0001 at the RPC and snapshot_not_found at the adapter', async () => {
    const snapshot = await createSnapshot()
    await ageSnapshotRelativeToRetention(snapshot.snapshot_id, '-1 minute')
    await createSnapshot()
    assert.equal(await snapshotExists(snapshot.snapshot_id), false)

    await assert.rejects(getPage(snapshot.snapshot_id, null, 10), (error: { code?: string }) => {
      assert.equal(error.code, 'P0001')
      return true
    })

    const rpc = async (_name: string, args: Record<string, unknown>) => {
      try {
        const result = await db.query<{ page: unknown }>(
          'select public.get_application_evidence_snapshot_page($1::uuid, $2::integer, $3::integer) as page',
          [args.p_snapshot_id as string, (args.p_after_ordinal ?? null) as number | null, args.p_limit as number],
        )
        return { data: result.rows[0].page, error: null }
      } catch (error) {
        return { data: null, error: { code: (error as { code?: string }).code, message: (error as Error).message } }
      }
    }
    assert.deepEqual(
      await getApplicationEvidenceSnapshotPage({ snapshot_id: snapshot.snapshot_id, limit: 10 }, rpc),
      { status: 'refused', code: 'snapshot_not_found' },
    )
  })

  it('keeps the creator and the retention definition service-role-only and clean under the security-definer audit', async () => {
    for (const signature of ['public.create_application_evidence_snapshot()', `public.${RETENTION_FUNCTION_NAME}()`]) {
      const privileges = await db.query<{ anon: boolean; authenticated: boolean; service_role: boolean }>(
        `select has_function_privilege('anon', $1::regprocedure, 'execute') as anon,
                has_function_privilege('authenticated', $1::regprocedure, 'execute') as authenticated,
                has_function_privilege('service_role', $1::regprocedure, 'execute') as service_role`,
        [signature],
      )
      assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service_role: true }, signature)
    }

    const creator = await db.query<{ security_definer: boolean; config: string[] | null }>(
      "select prosecdef as security_definer, proconfig as config from pg_proc where oid = 'public.create_application_evidence_snapshot()'::regprocedure",
    )
    assert.equal(creator.rows[0].security_definer, true)
    assert.deepEqual(creator.rows[0].config, ['search_path=pg_catalog, public'])

    const exposed = await db.query<{ signature: string }>(SECURITY_DEFINER_GRANTS_QUERY)
    assert.deepEqual(exposed.rows.map(row => row.signature), [])
  })
})
