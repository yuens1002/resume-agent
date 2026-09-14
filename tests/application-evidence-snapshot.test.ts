import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  createApplicationEvidenceSnapshot,
  getApplicationEvidenceSnapshotPage,
} from '../src/lib/application-evidence-snapshot.js'
import { registerApplicationEvidenceSnapshotTools } from '../src/lib/application-evidence-snapshot-tool.js'
import { MAX_ARTIFACT_BYTES, getApplicationResumeArtifact } from '../src/lib/application-resume-artifact.js'
import { registerApplicationResumeArtifactTool } from '../src/lib/application-resume-artifact-tool.js'
import { createHash } from 'node:crypto'

const baseline = readFileSync('supabase/migrations/20260329000000_job_hunt_pipeline.sql', 'utf8')
  .replace(/^create extension if not exists pg_trgm;$/m, '')
  .replace(/^create index .*gin_trgm_ops.*;$/gm, '')
const evidenceBundleMigration = readFileSync('supabase/migrations/20260913000000_application_evidence_bundle.sql', 'utf8')
const confirmationMigration = readFileSync('supabase/migrations/20260913000002_application_submission_confirmation.sql', 'utf8')
// PGlite does not package pgcrypto. The isolated PostgreSQL runner executes
// the production migration unchanged; this replacement keeps the PGlite
// contract fixture focused on trigger/snapshot behavior with the same
// 64-character hash shape.
const snapshotMigration = readFileSync('supabase/migrations/20260914000000_application_evidence_snapshot.sql', 'utf8')
  .replace(/^create extension if not exists pgcrypto;$/m, '')
  .replace("encode(digest(convert_to(new.job_description, 'UTF8'), 'sha256'), 'hex')", "repeat(md5(new.job_description), 2)")
const db = new PGlite()

type SnapshotMetadata = { snapshot_id: string; as_of: string; total_applications: number; snapshot_materialized: true }
type SnapshotPage = {
  snapshot: SnapshotMetadata
  applications: Array<{
    application: { application_id: string; company: string }
    job_description: { status: string; versions: unknown[] }
    score_versions: unknown[]
    submission_confirmation: { status: string; confirmations: Array<{ resume_id: string; confirmation_source: string; confirmation_recorded_at: string; actual_submission_occurred_at: string | null; source_ref: string | null }> }
  }>
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

before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.role() returns text language sql as $$ select current_user::text $$;")
  await db.exec('create schema storage; create table storage.buckets (id text primary key, name text, public boolean); create table storage.objects (bucket_id text);')
  await db.exec(baseline)
  await db.exec(evidenceBundleMigration)
  await db.exec(confirmationMigration)
  await db.exec(snapshotMigration)
})
after(() => db.close())

describe('application evidence snapshot SQL', () => {
  it('preserves legacy JD ambiguity and captures immutable JD and score provenance for new rows', async () => {
    const legacy = await db.query<{ id: string }>(
      "insert into job_applications(company, role, job_description) values ('legacy company', 'role', 'legacy JD') returning id",
    )
    // This fixture is intentionally created after the trigger exists, then its
    // version rows are removed to model an inherited record without inventing
    // a capture version. Production migration never performs this deletion.
    await db.query('delete from application_job_description_versions where application_id = $1', [legacy.rows[0].id])

    const current = await db.query<{ id: string }>(
      "insert into job_applications(company, role, job_description, url) values ('current company', 'role', 'current JD', 'https://example.test/posting') returning id",
    )
    const applicationId = current.rows[0].id
    const jdVersion = await db.query<{ id: string; content_hash: string }>(
      'select id, content_hash from application_job_description_versions where application_id = $1', [applicationId],
    )
    assert.equal(jdVersion.rows.length, 1)
    assert.match(jdVersion.rows[0].content_hash, /^[a-f0-9]{64}$/)

    const updated = await db.query<{ id: string }>(
      "update job_applications set job_description = 'current JD v2', url = 'https://example.test/posting-v2' where id = $1 returning id",
      [applicationId],
    )
    assert.equal(updated.rows.length, 1)
    const allJdVersions = await db.query<{ content: string; source_url: string }>(
      'select content, source_url from application_job_description_versions where application_id = $1 order by captured_at, id',
      [applicationId],
    )
    assert.deepEqual(allJdVersions.rows.map(row => [row.content, row.source_url]), [
      ['current JD', 'https://example.test/posting'],
      ['current JD v2', 'https://example.test/posting-v2'],
    ])

    const resumeA = await db.query<{ id: string }>(
      "insert into application_resumes(application_id, resume_content, is_submitted) values ($1, '{\"summary\":\"A\"}'::jsonb, false) returning id",
      [applicationId],
    )
    const resumeB = await db.query<{ id: string }>(
      "insert into application_resumes(application_id, resume_content, is_submitted) values ($1, '{\"summary\":\"B\"}'::jsonb, false) returning id",
      [applicationId],
    )
    await db.query(
      "insert into application_scores(application_id, resume_id, job_description_version_id, score_type, score, model, rubric_version, rubric_hash, profile_hash) values ($1, $2, $3, 'jd_fit', 0.81, 'synthetic-model', 'quality-extraction-v1', repeat('a', 64), repeat('b', 64))",
      [applicationId, resumeA.rows[0].id, jdVersion.rows[0].id],
    )
    await db.query(
      "insert into application_scores(application_id, resume_id, job_description_version_id, score_type, score, model, rubric_version, rubric_hash, profile_hash) values ($1, $2, $3, 'jd_fit', 0.74, 'synthetic-model', 'quality-extraction-v1', repeat('c', 64), repeat('d', 64))",
      [applicationId, resumeB.rows[0].id, jdVersion.rows[0].id],
    )

    const unrelated = await db.query<{ id: string }>(
      "insert into job_applications(company, role, job_description) values ('unrelated company', 'role', 'unrelated JD') returning id",
    )
    const unrelatedJdVersion = await db.query<{ id: string }>(
      'select id from application_job_description_versions where application_id = $1', [unrelated.rows[0].id],
    )
    await assert.rejects(
      db.query(
        "insert into application_scores(application_id, job_description_version_id, score_type) values ($1, $2, 'jd_fit')",
        [applicationId, unrelatedJdVersion.rows[0].id],
      ),
      /foreign key constraint/,
    )

    const confirmationApplication = await db.query<{ id: string }>(
      "insert into job_applications(company, role, stage) values ('confirmation company', 'role', 'draft') returning id",
    )
    const confirmationResume = await db.query<{ id: string }>(
      "insert into application_resumes(application_id, resume_content, is_submitted) values ($1, '{\"summary\":\"confirmed\"}'::jsonb, false) returning id",
      [confirmationApplication.rows[0].id],
    )
    const actualSubmissionTime = '2026-09-14T12:00:00.000Z'
    await db.query(
      "select public.confirm_application_submission($1::uuid, $2::uuid, null, $3::timestamptz, 'client_attested', 'synthetic-ref')",
      [confirmationApplication.rows[0].id, confirmationResume.rows[0].id, actualSubmissionTime],
    )

    const snapshot = await createSnapshot()
    const page = await getPage(snapshot.snapshot_id, null, 100)
    const currentEntry = page.applications.find(entry => entry.application.application_id === applicationId)!
    const legacyEntry = page.applications.find(entry => entry.application.application_id === legacy.rows[0].id)!
    assert.equal(currentEntry.job_description.status, 'versioned')
    assert.equal(currentEntry.job_description.versions.length, 2)
    assert.equal(currentEntry.score_versions.length, 2)
    assert.equal(legacyEntry.job_description.status, 'legacy_unversioned')
    assert.equal(legacyEntry.submission_confirmation.status, 'unverified')
    const confirmationEntry = page.applications.find(entry => entry.application.application_id === confirmationApplication.rows[0].id)!
    assert.equal(confirmationEntry.submission_confirmation.status, 'recorded')
    assert.deepEqual(confirmationEntry.submission_confirmation.confirmations.map(event => [event.resume_id, event.confirmation_source]), [
      [confirmationResume.rows[0].id, 'client_attested'],
    ])
    assert.equal(new Date(confirmationEntry.submission_confirmation.confirmations[0].actual_submission_occurred_at!).toISOString(), actualSubmissionTime)
    assert.equal(confirmationEntry.submission_confirmation.confirmations[0].source_ref, 'synthetic-ref')
    assert.match(confirmationEntry.submission_confirmation.confirmations[0].confirmation_recorded_at, /T/)
  })

  it('materializes every record beyond the interactive cap and keeps pages stable after a source mutation', async () => {
    const applications = await db.query<{ id: string }>(
      "insert into job_applications(company, role, job_description) select 'snapshot company ' || n, 'role', 'snapshot JD ' || n from generate_series(1, 101) n returning id",
    )
    assert.equal(applications.rows.length, 101)

    const snapshot = await createSnapshot()
    const pages: SnapshotPage[] = []
    let after: number | null = null
    do {
      const page = await getPage(snapshot.snapshot_id, after, 50)
      pages.push(page)
      after = page.next_cursor?.ordinal ?? null
    } while (after !== null)

    const entries = pages.flatMap(page => page.applications)
    assert.equal(snapshot.total_applications, entries.length)
    assert.equal(new Set(entries.map(entry => entry.application.application_id)).size, entries.length)
    assert.equal(pages.at(-1)?.is_final_page, true)
    assert.ok(pages.slice(0, -1).every(page => !page.is_final_page && page.next_cursor !== null))

    const captured = entries.find(entry => entry.application.application_id === applications.rows[0].id)!
    await db.query("update job_applications set company = 'changed after snapshot', job_description = 'changed JD' where id = $1", [applications.rows[0].id])
    const replay = await getPage(snapshot.snapshot_id, null, 100)
    const replayed = replay.applications.find(entry => entry.application.application_id === applications.rows[0].id)!
    assert.equal(replayed.application.company, captured.application.company)
  })

  it('rejects invalid pages and keeps snapshot RPC access service-role-only', async () => {
    const snapshot = await createSnapshot()
    await assert.rejects(getPage(snapshot.snapshot_id, -1, 10), /Snapshot cursor is invalid/)
    await assert.rejects(getPage(snapshot.snapshot_id, null, 101), /Page limit must be between 1 and 100/)
    await assert.rejects(getPage('00000000-0000-0000-0000-000000000000', null, 10), /Evidence snapshot not found/)
    for (const role of ['anon', 'authenticated']) {
      const privilege = await db.query<{ allowed: boolean }>(
        "select has_function_privilege($1, 'public.create_application_evidence_snapshot()', 'execute') as allowed", [role],
      )
      assert.equal(privilege.rows[0].allowed, false)
    }
    const service = await db.query<{ allowed: boolean }>(
      "select has_function_privilege('service_role', 'public.get_application_evidence_snapshot_page(uuid,integer,integer)', 'execute') as allowed",
    )
    assert.equal(service.rows[0].allowed, true)
  })
})

describe('application evidence snapshot adapter and MCP tools', () => {
  it('validates create/page responses and maps source failures without exposing source details', async () => {
    const rpc = async (name: string, args: Record<string, unknown>) => {
      if (name === 'create_application_evidence_snapshot') {
        const result = await db.query<{ snapshot: unknown }>('select public.create_application_evidence_snapshot() as snapshot')
        return { data: result.rows[0].snapshot, error: null }
      }
      const result = await db.query<{ page: unknown }>(
        'select public.get_application_evidence_snapshot_page($1::uuid, $2::integer, $3::integer) as page',
        [args.p_snapshot_id as string, args.p_after_ordinal as number | null, args.p_limit as number],
      )
      return { data: result.rows[0].page, error: null }
    }
    const created = await createApplicationEvidenceSnapshot({}, rpc)
    assert.equal(created.status, 'ok')
    if (created.status !== 'ok') return
    const page = await getApplicationEvidenceSnapshotPage({ snapshot_id: created.snapshot.snapshot_id, limit: 25 }, rpc)
    assert.equal(page.status, 'ok')
    assert.deepEqual(await createApplicationEvidenceSnapshot({ unexpected: true }, rpc), { status: 'refused', code: 'invalid_input' })
    assert.deepEqual(await getApplicationEvidenceSnapshotPage({ snapshot_id: created.snapshot.snapshot_id, limit: 101 }, rpc), { status: 'refused', code: 'invalid_input' })
    assert.deepEqual(await getApplicationEvidenceSnapshotPage({ snapshot_id: created.snapshot.snapshot_id }, async () => ({ data: null, error: { code: '22023', message: 'private detail' } })), { status: 'refused', code: 'invalid_cursor_or_limit' })
  })

  it('registers a protected creator and a read-only page tool', async () => {
    const server = new McpServer({ name: 'test', version: '1' })
    registerApplicationEvidenceSnapshotTools(server, async () => ({ data: null, error: { code: 'P0001' } }))
    registerApplicationResumeArtifactTool(server, {
      readResume: async () => ({ data: null, error: null }),
      download: async () => ({ data: null, error: null }),
    })
    const client = new Client({ name: 'test-client', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const tools = await client.listTools()
      const create = tools.tools.find(tool => tool.name === 'create_application_evidence_snapshot')!
      const page = tools.tools.find(tool => tool.name === 'get_application_evidence_snapshot_page')!
      const artifact = tools.tools.find(tool => tool.name === 'get_application_resume_artifact')!
      assert.equal(create.annotations?.readOnlyHint, false)
      assert.equal(page.annotations?.readOnlyHint, true)
      assert.equal(artifact.annotations?.readOnlyHint, true)
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('application resume artifact reader', () => {
  const applicationId = '11111111-1111-4111-8111-111111111111'
  const resumeId = '22222222-2222-4222-8222-222222222222'
  const bytes = Buffer.from('synthetic artifact bytes')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const source = (overrides: Partial<{
    row: { docx_url: string | null; docx_hash: string | null; pdf_url: string | null; pdf_hash: string | null } | null
    blob: Blob | null
    readError: unknown | null
    downloadError: unknown | null
  }> = {}) => ({
    readResume: async () => ({
      data: overrides.row === undefined ? { docx_url: 'owned/doc.docx', docx_hash: sha256, pdf_url: null, pdf_hash: null } : overrides.row,
      error: overrides.readError ?? null,
    }),
    download: async () => ({ data: overrides.blob === undefined ? new Blob([bytes]) : overrides.blob, error: overrides.downloadError ?? null }),
  })

  it('resolves only the stored application/resume artifact and verifies returned bytes', async () => {
    const result = await getApplicationResumeArtifact({ application_id: applicationId, resume_id: resumeId, format: 'docx' }, source())
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.artifact.bytes_base64, bytes.toString('base64'))
    assert.equal(result.artifact.sha256, sha256)
    assert.equal(result.artifact.mime_type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  it('refuses a missing/wrong application-resume pair, oversized or unavailable bytes, and a hash mismatch', async () => {
    const request = { application_id: applicationId, resume_id: resumeId, format: 'docx' as const }
    assert.deepEqual(await getApplicationResumeArtifact(request, source({ row: null })), { status: 'refused', code: 'artifact_not_found' })
    assert.deepEqual(await getApplicationResumeArtifact(request, source({ blob: new Blob([new Uint8Array(MAX_ARTIFACT_BYTES + 1)]) })), { status: 'refused', code: 'artifact_too_large' })
    assert.deepEqual(await getApplicationResumeArtifact(request, source({ downloadError: new Error('synthetic') })), { status: 'refused', code: 'artifact_unavailable' })
    assert.deepEqual(await getApplicationResumeArtifact(request, source({ blob: new Blob([Buffer.from('different bytes')]) })), { status: 'refused', code: 'artifact_hash_mismatch' })
  })
})
