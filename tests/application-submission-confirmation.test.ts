import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const original = readFileSync('supabase/migrations/20260329000000_job_hunt_pipeline.sql', 'utf8')
const evidenceBundleMigration = readFileSync('supabase/migrations/20260913000000_application_evidence_bundle.sql', 'utf8')
const confirmationMigration = readFileSync('supabase/migrations/20260913000002_application_submission_confirmation.sql', 'utf8')
// PGlite lacks this optional index extension. The tables, constraints, RLS,
// and confirmation function execute unchanged.
const baseline = original.replace(/^create extension if not exists pg_trgm;$/m, '')
  .replace(/^create index .*gin_trgm_ops.*;$/gm, '')
const db = new PGlite()

type DraftFixture = { applicationId: string; resumeId: string }

async function addDraft(label: string): Promise<DraftFixture> {
  const application = await db.query<{ id: string }>(
    'insert into job_applications(company, role, stage) values ($1, $2, $3) returning id',
    [`${label} company`, 'Senior TypeScript Engineer', 'draft'],
  )
  const applicationId = application.rows[0].id
  await db.query(
    'insert into application_stages(application_id, stage, note) values ($1, $2, $3)',
    [applicationId, 'draft', 'Application tailored, not yet confirmed submitted'],
  )
  const resume = await db.query<{ id: string }>(
    'insert into application_resumes(application_id, resume_content, is_submitted) values ($1, $2::jsonb, false) returning id',
    [applicationId, JSON.stringify({ summary: `${label} draft resume` })],
  )
  return { applicationId, resumeId: resume.rows[0].id }
}

before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.role() returns text language sql as $$ select current_user::text $$;")
  await db.exec('create schema storage; create table storage.buckets (id text primary key, name text, public boolean); create table storage.objects (bucket_id text);')
  await db.exec(baseline)
  await db.exec(evidenceBundleMigration)
  await db.exec(confirmationMigration)
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
