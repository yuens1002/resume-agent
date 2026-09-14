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
// the production migration unchanged and verifies the real SHA-256 values;
// this fixture only substitutes a 64-character placeholder for that engine.
const snapshotMigration = readFileSync('supabase/migrations/20260914000000_application_evidence_snapshot.sql', 'utf8')
  .replace(/^create extension if not exists pgcrypto;$/m, '')
  .replace("encode(digest(convert_to(new.job_description, 'UTF8'), 'sha256'), 'hex')", "repeat(md5(new.job_description), 2)")
  .replaceAll("encode(digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex')", "repeat(md5(v_payload::text), 2)")
const db = new PGlite()

type SnapshotMetadata = { snapshot_id: string; as_of: string; total_applications: number; snapshot_materialized: true }
type SnapshotPage = {
  snapshot: SnapshotMetadata
  applications: Array<{
    application: {
      application_id: string
      company: string
      fit_score: number | null
      match_verdict: string | null
      match_scoring: unknown | null
      recommended_action: string | null
    }
    job_description: { status: string; versions: unknown[] }
    score_versions: unknown[]
    submission_confirmation: { status: string; confirmations: Array<{ resume_id: string; confirmation_source: string; confirmation_recorded_at: string; actual_submission_occurred_at: string | null; source_ref: string | null; submitted_artifact_format: string | null; submitted_artifact_hash: string | null; submitted_job_description_version_id: string | null }> }
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

    const captureOperationId = '00000000-0000-4000-8000-000000000001'
    const replacementCaptureOperationId = '00000000-0000-4000-8000-000000000002'
    const current = await db.query<{ id: string }>(
      "insert into job_applications(company, role, job_description, url, job_description_capture_operation_id, fit_score, match_verdict, match_scoring, recommended_action) values ('current company', 'role', 'current JD', 'https://example.test/posting', $1::uuid, 0.81, 'strong match', '{\"source\":\"fixture\"}'::jsonb, 'apply') returning id",
      [captureOperationId],
    )
    const applicationId = current.rows[0].id
    const jdVersion = await db.query<{ id: string; content_hash: string }>(
      'select id, content_hash from application_job_description_versions where application_id = $1', [applicationId],
    )
    assert.equal(jdVersion.rows.length, 1)
    assert.match(jdVersion.rows[0].content_hash, /^[a-f0-9]{64}$/)

    const updated = await db.query<{ id: string }>(
      "update job_applications set job_description = 'current JD v2', url = 'https://example.test/posting-v2', job_description_capture_operation_id = $2::uuid where id = $1 returning id",
      [applicationId, replacementCaptureOperationId],
    )
    assert.equal(updated.rows.length, 1)
    const allJdVersions = await db.query<{ content: string; source_url: string; capture_operation_id: string }>(
      'select content, source_url, capture_operation_id from application_job_description_versions where application_id = $1 order by captured_at, id',
      [applicationId],
    )
    assert.deepEqual(allJdVersions.rows.map(row => [row.content, row.source_url, row.capture_operation_id]), [
      ['current JD', 'https://example.test/posting', captureOperationId],
      ['current JD v2', 'https://example.test/posting-v2', replacementCaptureOperationId],
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
      "insert into job_applications(company, role, stage, job_description) values ('confirmation company', 'role', 'draft', 'confirmation JD') returning id",
    )
    const confirmationJdVersion = await db.query<{ id: string }>(
      'select id from application_job_description_versions where application_id = $1', [confirmationApplication.rows[0].id],
    )
    const confirmationResume = await db.query<{ id: string }>(
      "insert into application_resumes(application_id, resume_content, pdf_hash, docx_hash, is_submitted) values ($1, '{\"summary\":\"confirmed\"}'::jsonb, repeat('e',64), repeat('f',64), false) returning id",
      [confirmationApplication.rows[0].id],
    )
    const confirmationHash = await db.query<{ pdf_hash: string }>('select pdf_hash from application_resumes where id = $1', [confirmationResume.rows[0].id])
    const actualSubmissionTime = '2026-09-14T12:00:00.000Z'
    await db.query(
      "select public.confirm_application_submission($1::uuid, $2::uuid, null, $3::timestamptz, 'client_attested', 'synthetic-ref', $4::uuid, 'pdf', $5)",
      [confirmationApplication.rows[0].id, confirmationResume.rows[0].id, actualSubmissionTime, confirmationJdVersion.rows[0].id, confirmationHash.rows[0].pdf_hash],
    )

    const snapshot = await createSnapshot()
    const page = await getPage(snapshot.snapshot_id, null, 100)
    const currentEntry = page.applications.find(entry => entry.application.application_id === applicationId)!
    const legacyEntry = page.applications.find(entry => entry.application.application_id === legacy.rows[0].id)!
    assert.equal(currentEntry.job_description.status, 'versioned')
    assert.equal(currentEntry.application.fit_score, 0.81)
    assert.equal(currentEntry.application.match_verdict, 'strong match')
    assert.deepEqual(currentEntry.application.match_scoring, { source: 'fixture' })
    assert.equal(currentEntry.application.recommended_action, 'apply')
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
    assert.equal(confirmationEntry.submission_confirmation.confirmations[0].submitted_artifact_format, 'pdf')
    assert.equal(confirmationEntry.submission_confirmation.confirmations[0].submitted_artifact_hash, confirmationHash.rows[0].pdf_hash)
    assert.equal(confirmationEntry.submission_confirmation.confirmations[0].submitted_job_description_version_id, confirmationJdVersion.rows[0].id)
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

  it('preserves source-attributed outcome revisions and refuses conflicting or unsupported no-response coverage', async () => {
    const application = await db.query<{ id: string }>("insert into job_applications(company, role) values ('outcome company', 'role') returning id")
    const appId = application.rows[0].id
    const sourceEventId = `imap:${'a'.repeat(64)}:123:456`
    const coverageRef = `imap-coverage:${'a'.repeat(64)}:123:1788307200000:0:0`
    const evidenceHash = '1'.repeat(64)
    const first = await db.query<{ outcome: { event_id: string; idempotent: boolean } }>(
      "select public.record_application_observed_outcome($1::uuid, 'granted_inbox', $2, 1, 'other_response', null, $2, $3, 'automated_ack', null, null) as outcome",
      [appId, sourceEventId, evidenceHash],
    )
    const replay = await db.query<{ outcome: { event_id: string; idempotent: boolean } }>(
      "select public.record_application_observed_outcome($1::uuid, 'granted_inbox', $2, 1, 'other_response', null, $2, $3, 'automated_ack', null, null) as outcome",
      [appId, sourceEventId, evidenceHash],
    )
    assert.equal(replay.rows[0].outcome.event_id, first.rows[0].outcome.event_id)
    assert.equal(replay.rows[0].outcome.idempotent, true)
    await assert.rejects(
      db.query("select public.record_application_observed_outcome($1::uuid, 'granted_inbox', $2, 1, 'recruiter_contact', null, $2, $3, 'explicit_email_content', null, null)", [appId, sourceEventId, evidenceHash]),
      /conflicts/,
    )
    await db.query(
      "select public.record_application_observed_outcome($1::uuid, 'granted_inbox', $2, 2, 'recruiter_contact', null, $2, $3, 'explicit_email_content', false, $4::uuid)",
      [appId, sourceEventId, evidenceHash, first.rows[0].outcome.event_id],
    )
    await assert.rejects(
      db.query("select public.record_application_outcome_check($1::uuid, 'imap_inbox', 'coverage-1', $2::timestamptz, $3::timestamptz, 'inbox_internaldate_v1', null, false, 'no_response', 0, 0, $4)", [appId, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', coverageRef]),
      /lacks complete attributed submission evidence/,
    )
    const confirmedApplication = await db.query<{ id: string }>("insert into job_applications(company, role, stage) values ('coverage company', 'role', 'draft') returning id")
    const confirmedApplicationId = confirmedApplication.rows[0].id
    const confirmedResume = await db.query<{ id: string }>(
      "insert into application_resumes(application_id, resume_content, pdf_hash, is_submitted) values ($1, '{\"summary\":\"coverage\"}'::jsonb, repeat('e', 64), false) returning id",
      [confirmedApplicationId],
    )
    const submissionTime = '2020-01-03T00:00:00.000Z'
    await db.query(
      "select public.confirm_application_submission($1::uuid, $2::uuid, null, $3::timestamptz, 'client_attested', 'synthetic-ref', null, 'pdf', repeat('e', 64))",
      [confirmedApplicationId, confirmedResume.rows[0].id, submissionTime],
    )
    const beforeSubmissionEnd = '2020-01-02T00:00:00.000Z'
    const beforeSubmissionRef = `imap-coverage:${'b'.repeat(64)}:124:${new Date(beforeSubmissionEnd).getTime()}:0:0`
    await assert.rejects(
      db.query(
        "select public.record_application_outcome_check($1::uuid, 'imap_inbox', 'coverage-before-submission', $2::timestamptz, $3::timestamptz, 'inbox_internaldate_v1', $4::timestamptz, true, 'no_response', 0, 0, $5)",
        [confirmedApplicationId, '2020-01-01T00:00:00.000Z', beforeSubmissionEnd, submissionTime, beforeSubmissionRef],
      ),
      /lacks complete attributed submission evidence/,
    )
    const coveringEnd = '2020-01-04T00:00:00.000Z'
    const coveringRef = `imap-coverage:${'b'.repeat(64)}:124:${new Date(coveringEnd).getTime()}:0:0`
    const covering = await db.query<{ outcome: { idempotent: boolean } }>(
      "select public.record_application_outcome_check($1::uuid, 'imap_inbox', 'coverage-includes-submission', $2::timestamptz, $3::timestamptz, 'inbox_internaldate_v1', $4::timestamptz, true, 'no_response', 0, 0, $5) as outcome",
      [confirmedApplicationId, '2020-01-01T00:00:00.000Z', coveringEnd, submissionTime, coveringRef],
    )
    assert.equal(covering.rows[0].outcome.idempotent, false)
    const snapshot = await createSnapshot()
    const page = await getPage(snapshot.snapshot_id, null, 100)
    const entry = page.applications.find(item => item.application.application_id === appId) as unknown as { observed_outcomes: Array<{ revision: number; event_type: string }> }
    assert.deepEqual(entry.observed_outcomes.map(event => [event.revision, event.event_type]), [[1, 'other_response'], [2, 'recruiter_contact']])
    await assert.rejects(
      db.query("select public.record_application_observed_outcome($1::uuid, 'granted_inbox', $2, 3, 'offer_accepted', null, $2, $3, 'unclassified', false, $4::uuid)", [appId, sourceEventId, evidenceHash, first.rows[0].outcome.event_id]),
      /requires explicit attributed email evidence/,
    )
    await assert.rejects(db.query("delete from job_applications where id = $1::uuid", [appId]), /violates (RESTRICT|foreign key constraint)/)
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
    stream: ReadableStream<Uint8Array> | null
    readError: unknown | null
    downloadError: unknown | null
  }> = {}) => ({
    readResume: async () => ({
      data: overrides.row === undefined ? { docx_url: 'owned/doc.docx', docx_hash: sha256, pdf_url: null, pdf_hash: null } : overrides.row,
      error: overrides.readError ?? null,
    }),
    download: async () => ({ data: overrides.stream === undefined ? new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }) : overrides.stream, error: overrides.downloadError ?? null }),
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
    let cancelled = false
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_ARTIFACT_BYTES + 1)) },
      cancel() { cancelled = true },
    })
    assert.deepEqual(await getApplicationResumeArtifact(request, source({ stream: oversized })), { status: 'refused', code: 'artifact_too_large' })
    assert.equal(cancelled, true)
    assert.deepEqual(await getApplicationResumeArtifact(request, source({ downloadError: new Error('synthetic') })), { status: 'refused', code: 'artifact_unavailable' })
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('synthetic stream failure')) } })
    assert.deepEqual(await getApplicationResumeArtifact(request, source({ stream: broken })), { status: 'refused', code: 'artifact_unavailable' })
    assert.deepEqual(await getApplicationResumeArtifact(request, source({ stream: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('different bytes')); controller.close() } }) })), { status: 'refused', code: 'artifact_hash_mismatch' })
  })
})
