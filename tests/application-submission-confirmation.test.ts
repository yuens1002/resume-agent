import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const original = readFileSync('supabase/migrations/20260329000000_job_hunt_pipeline.sql', 'utf8')
const evidenceBundleMigration = readFileSync('supabase/migrations/20260913000000_application_evidence_bundle.sql', 'utf8')
const confirmationMigration = readFileSync('supabase/migrations/20260913000002_application_submission_confirmation.sql', 'utf8')
const snapshotMigration = readFileSync('supabase/migrations/20260914000000_application_evidence_snapshot.sql', 'utf8')
  .replace("encode(pg_catalog.sha256(pg_catalog.convert_to(new.job_description, 'UTF8')), 'hex')", "repeat(md5(new.job_description), 2)")
// PGlite lacks this optional index extension. The tables, constraints, RLS,
// and confirmation function execute unchanged.
const baseline = original.replace(/^create extension if not exists pg_trgm;$/m, '')
  .replace(/^create index .*gin_trgm_ops.*;$/gm, '')
const db = new PGlite()

type DraftFixture = { applicationId: string; resumeId: string }

async function addDraft(label: string, hashes?: { pdf: string; docx: string }): Promise<DraftFixture> {
  const application = await db.query<{ id: string }>(
    'insert into job_applications(company, role, stage, job_description) values ($1, $2, $3, $4) returning id',
    [`${label} company`, 'Senior TypeScript Engineer', 'draft', `${label} job description`],
  )
  const applicationId = application.rows[0].id
  await db.query(
    'insert into application_stages(application_id, stage, note) values ($1, $2, $3)',
    [applicationId, 'draft', 'Application tailored, not yet confirmed submitted'],
  )
  const resume = await db.query<{ id: string }>(
    'insert into application_resumes(application_id, resume_content, pdf_hash, docx_hash, is_submitted) values ($1, $2::jsonb, $3, $4, false) returning id',
    [applicationId, JSON.stringify({ summary: `${label} draft resume` }), hashes?.pdf ?? null, hashes?.docx ?? null],
  )
  return { applicationId, resumeId: resume.rows[0].id }
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

describe('application submission confirmation SQL', () => {
  it('accepts draft stage history and atomically confirms the exact selected resume', async () => {
    const { applicationId, resumeId } = await addDraft('confirm')
    await db.query("update job_applications set applied_at = '2000-01-01T00:00:00Z' where id = $1", [applicationId])

    const result = await db.query<{ confirmation: { application_id: string; resume_id: string; previous_stage: string; stage: string } }>(
      'select public.confirm_application_submission($1::uuid, $2::uuid, $3) as confirmation',
      [applicationId, resumeId, 'Sent through the employer portal'],
    )
    assert.equal(result.rows[0].confirmation.application_id, applicationId)
    assert.equal(result.rows[0].confirmation.resume_id, resumeId)
    assert.equal(result.rows[0].confirmation.previous_stage, 'draft')
    assert.equal(result.rows[0].confirmation.stage, 'applied')

    const application = await db.query<{ stage: string; applied_at: string }>('select stage, applied_at from job_applications where id = $1', [applicationId])
    assert.equal(application.rows[0].stage, 'applied')
    assert.ok(new Date(application.rows[0].applied_at) > new Date('2020-01-01T00:00:00Z'))
    const resume = await db.query<{ is_submitted: boolean }>('select is_submitted from application_resumes where id = $1', [resumeId])
    assert.equal(resume.rows[0].is_submitted, true)
    const history = await db.query<{ stage: string; note: string | null }>(
      'select stage, note from application_stages where application_id = $1 order by occurred_at, id',
      [applicationId],
    )
    assert.deepEqual(history.rows.map(row => row.stage).sort(), ['applied', 'draft'])
    assert.ok(history.rows.some(row => row.stage === 'applied' && row.note === 'Sent through the employer portal'))
  })

  it('rejects unrelated evidence without partially changing the draft', async () => {
    const target = await addDraft('target')
    const other = await addDraft('other')

    await assert.rejects(
      db.query('select public.confirm_application_submission($1::uuid, $2::uuid)', [target.applicationId, other.resumeId]),
      /Unsubmitted resume evidence not found for application/,
    )

    const application = await db.query<{ stage: string }>('select stage from job_applications where id = $1', [target.applicationId])
    assert.equal(application.rows[0].stage, 'draft')
    const resume = await db.query<{ is_submitted: boolean }>('select is_submitted from application_resumes where id = $1', [target.resumeId])
    assert.equal(resume.rows[0].is_submitted, false)
    const history = await db.query<{ count: number }>('select count(*)::int as count from application_stages where application_id = $1', [target.applicationId])
    assert.equal(history.rows[0].count, 1)
  })

  it('records only the attested selected PDF and rejects missing, mismatched, or cross-application evidence atomically', async () => {
    const pdfHash = 'a'.repeat(64)
    const docxHash = 'b'.repeat(64)
    const selected = await addDraft('attested-pdf', { pdf: pdfHash, docx: docxHash })
    const selectedJd = await db.query<{ id: string }>(
      'select id from application_job_description_versions where application_id = $1', [selected.applicationId],
    )
    await db.query(
      "select public.confirm_application_submission($1::uuid, $2::uuid, null, $3::timestamptz, 'client_attested', 'receipt:synthetic', $4::uuid, 'pdf', $5)",
      [selected.applicationId, selected.resumeId, '2026-09-14T12:00:00Z', selectedJd.rows[0].id, pdfHash],
    )
    const event = await db.query<{ submitted_artifact_format: string; submitted_artifact_hash: string; submitted_job_description_version_id: string }>(
      'select submitted_artifact_format, submitted_artifact_hash, submitted_job_description_version_id from application_submission_confirmations where application_id = $1',
      [selected.applicationId],
    )
    assert.deepEqual(event.rows[0], {
      submitted_artifact_format: 'pdf',
      submitted_artifact_hash: pdfHash,
      submitted_job_description_version_id: selectedJd.rows[0].id,
    })

    const wrongPair = await addDraft('wrong-pair', { pdf: 'c'.repeat(64), docx: 'd'.repeat(64) })
    const wrongPairJd = await db.query<{ id: string }>('select id from application_job_description_versions where application_id = $1', [wrongPair.applicationId])
    await assert.rejects(
      db.query(
        "select public.confirm_application_submission($1::uuid, $2::uuid, null, null, 'unknown', null, $3::uuid, 'pdf', $4)",
        [wrongPair.applicationId, wrongPair.resumeId, wrongPairJd.rows[0].id, 'd'.repeat(64)],
      ),
      /Submitted artifact hash does not match the selected resume/,
    )
    await assert.rejects(
      db.query(
        "select public.confirm_application_submission($1::uuid, $2::uuid, null, null, 'unknown', null, $3::uuid, 'docx', null)",
        [wrongPair.applicationId, wrongPair.resumeId, wrongPairJd.rows[0].id],
      ),
      /Submitted artifact format and hash must be supplied together/,
    )

    const other = await addDraft('other-jd', { pdf: 'e'.repeat(64), docx: 'f'.repeat(64) })
    const otherJd = await db.query<{ id: string }>('select id from application_job_description_versions where application_id = $1', [other.applicationId])
    await assert.rejects(
      db.query(
        "select public.confirm_application_submission($1::uuid, $2::uuid, null, null, 'unknown', null, $3::uuid, 'pdf', $4)",
        [wrongPair.applicationId, wrongPair.resumeId, otherJd.rows[0].id, 'c'.repeat(64)],
      ),
      /foreign key constraint/,
    )
    const unchanged = await db.query<{ stage: string; is_submitted: boolean; confirmations: number }>(
      `select application.stage, resume.is_submitted,
        (select count(*)::int from application_submission_confirmations where application_id = application.id) as confirmations
       from job_applications application join application_resumes resume on resume.application_id = application.id
       where application.id = $1 and resume.id = $2`,
      [wrongPair.applicationId, wrongPair.resumeId],
    )
    assert.deepEqual(unchanged.rows[0], { stage: 'draft', is_submitted: false, confirmations: 0 })
  })

  it('rolls back evidence and stage when appending the applied history fails', async () => {
    const target = await addDraft('history-failure')
    await db.exec(`
      create function reject_applied_history() returns trigger language plpgsql as $$
      begin
        if new.stage = 'applied' then raise exception 'applied history rejected for test'; end if;
        return new;
      end;
      $$;
      create trigger reject_applied_history before insert on application_stages
        for each row execute function reject_applied_history();
    `)

    try {
      await assert.rejects(
        db.query('select public.confirm_application_submission($1::uuid, $2::uuid)', [target.applicationId, target.resumeId]),
        /applied history rejected for test/,
      )
    } finally {
      await db.exec('drop trigger reject_applied_history on application_stages; drop function reject_applied_history();')
    }

    const application = await db.query<{ stage: string }>('select stage from job_applications where id = $1', [target.applicationId])
    assert.equal(application.rows[0].stage, 'draft')
    const resume = await db.query<{ is_submitted: boolean }>('select is_submitted from application_resumes where id = $1', [target.resumeId])
    assert.equal(resume.rows[0].is_submitted, false)
    const history = await db.query<{ count: number }>('select count(*)::int as count from application_stages where application_id = $1', [target.applicationId])
    assert.equal(history.rows[0].count, 1)
  })

  it('exposes confirmation only to the service role and replays safely', async () => {
    for (const role of ['anon', 'authenticated']) {
      const privilege = await db.query<{ allowed: boolean }>(
        "select has_function_privilege($1, 'public.confirm_application_submission(uuid,uuid,text)', 'execute') as allowed",
        [role],
      )
      assert.equal(privilege.rows[0].allowed, false)
    }
    const servicePrivilege = await db.query<{ allowed: boolean }>(
      "select has_function_privilege('service_role', 'public.confirm_application_submission(uuid,uuid,text)', 'execute') as allowed",
    )
    assert.equal(servicePrivilege.rows[0].allowed, true)

    await db.exec(confirmationMigration)
    const { applicationId, resumeId } = await addDraft('replayed')
    await db.query('select public.confirm_application_submission($1::uuid, $2::uuid)', [applicationId, resumeId])
    const application = await db.query<{ stage: string }>('select stage from job_applications where id = $1', [applicationId])
    assert.equal(application.rows[0].stage, 'applied')
  })
})
