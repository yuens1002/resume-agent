// Disposable, network-isolated PostgreSQL only. Never reads deployment credentials.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const run = promisify(execFile)
const container = `job-feed-check-${randomUUID()}`
const options = { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }
const migration = readFileSync('supabase/migrations/20260912000000_job_pipeline_feed.sql', 'utf8')
const evidenceBundleMigration = readFileSync('supabase/migrations/20260913000000_application_evidence_bundle.sql', 'utf8')
const draftDueWorkMigration = readFileSync('supabase/migrations/20260913000001_job_pipeline_feed_drafts.sql', 'utf8')
const confirmationMigration = readFileSync('supabase/migrations/20260913000002_application_submission_confirmation.sql', 'utf8')
const applicationEvidenceSnapshotMigration = readFileSync('supabase/migrations/20260914000000_application_evidence_snapshot.sql', 'utf8')
const baseline = readFileSync('supabase/migrations/20260329000000_job_hunt_pipeline.sql', 'utf8')
  .replace(/^create extension if not exists pg_trgm;$/m, '')
  .replace(/^create index .*gin_trgm_ops.*;$/gm, '')
const sql = query => new Promise((resolve, reject) => {
  // -f - sends statements independently like db:push, unlike a single -c query.
  const child = execFile('docker', ['exec', '-i', container, 'psql', '-X', '-qAt',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'], options,
  (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim()))
  child.stdin.on('error', () => {}) // process exit is handled by the callback
  child.stdin.end(query)
})
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Expected database/lock state was not observed')
}
const countIsOne = query => async () => Number(await sql(query)) === 1
const readFeed = async cursor => JSON.parse(await sql(cursor
  ? `select get_job_pipeline_feed('${cursor.generation}',${cursor.sequence},'UTC');`
  : 'select get_job_pipeline_feed();'))
let started = false
try {
  await run('docker', ['run', '-d', '--name', container, '--network', 'none',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine'], options)
  started = true
  await waitFor(async () => { try { return Number(await sql('select 1;')) === 1 } catch { return false } })
  // Production has pgcrypto outside public. The snapshot migration must not
  // depend on that extension's schema because its SECURITY DEFINER functions
  // intentionally restrict search_path to pg_catalog, public.
  await sql("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema extensions; create extension pgcrypto with schema extensions; create function auth.role() returns text language sql as $$ select current_user::text $$;")
  await sql('create schema storage; create table storage.buckets (id text primary key, name text, public boolean); create table storage.objects (bucket_id text);')
  await sql(baseline)
  await sql(migration)
  await sql(evidenceBundleMigration)
  await sql(draftDueWorkMigration)
  await sql(confirmationMigration)
  await sql(applicationEvidenceSnapshotMigration)
  assert.equal(await sql("select to_regprocedure('pg_catalog.sha256(bytea)') is not null and to_regprocedure('public.digest(bytea,text)') is null and to_regprocedure('extensions.digest(bytea,text)') is not null;"), 't')

  const beforeDraft = await readFeed()
  const draftId = await sql("insert into job_applications(company,role,stage,follow_up_date) values ('draft_feed','test','draft',current_date-1) returning id;")
  const draftFeed = await readFeed(beforeDraft.next_cursor)
  assert.equal(draftFeed.summary.by_stage.draft, (beforeDraft.summary.by_stage.draft ?? 0) + 1)
  assert.equal(draftFeed.changes[0].application.stage, 'draft')
  assert.ok(!draftFeed.due_work.some(application => application.application_id === draftId))
  assert.deepEqual((await readFeed(beforeDraft.next_cursor)).changes, draftFeed.changes)
  await sql(`update job_applications set stage='applied' where id='${draftId}';`)
  const appliedFeed = await readFeed(draftFeed.next_cursor)
  assert.equal(appliedFeed.changes[0].application.stage, 'applied')
  assert.ok(appliedFeed.due_work.some(application => application.application_id === draftId))
  console.log('PASS drafts: SQL migration accepts feed snapshots, excludes draft due work, and replays transition')

  const confirmationAppId = await sql("insert into job_applications(company,role,stage) values ('confirmation','test','draft') returning id;")
  const confirmationResumeId = await sql(`insert into application_resumes(application_id,resume_content,is_submitted) values ('${confirmationAppId}','{}',false) returning id;`)
  await sql(`insert into application_stages(application_id,stage,note) values ('${confirmationAppId}','draft','tailored');`)
  const confirmation = JSON.parse(await sql(`select confirm_application_submission('${confirmationAppId}','${confirmationResumeId}','sent');`))
  assert.equal(confirmation.application_id, confirmationAppId)
  assert.equal(confirmation.resume_id, confirmationResumeId)
  assert.equal(await sql(`select stage from job_applications where id='${confirmationAppId}';`), 'applied')
  assert.equal(await sql(`select is_submitted from application_resumes where id='${confirmationResumeId}';`), 't')
  assert.equal(await sql(`select count(*) from application_stages where application_id='${confirmationAppId}' and stage='applied' and note='sent';`), '1')
  console.log('PASS confirmation: PostgreSQL atomically records selected evidence, stage, and history')

  const snapshotApplicationId = await sql("insert into job_applications(company,role,job_description,url) values ('snapshot','test','snapshot JD','https://example.test/snapshot') returning id;")
  const snapshot = JSON.parse(await sql('select create_application_evidence_snapshot();'))
  assert.equal(snapshot.snapshot_materialized, true)
  const snapshotPage = JSON.parse(await sql(`select get_application_evidence_snapshot_page('${snapshot.snapshot_id}',null,100);`))
  const snapshotEntry = snapshotPage.applications.find(entry => entry.application.application_id === snapshotApplicationId)
  assert.equal(snapshotEntry.job_description.status, 'versioned')
  assert.equal(snapshotEntry.job_description.versions[0].content, 'snapshot JD')
  const confirmationEntry = snapshotPage.applications.find(entry => entry.application.application_id === confirmationAppId)
  assert.equal(confirmationEntry.submission_confirmation.status, 'recorded')
  assert.equal(confirmationEntry.submission_confirmation.confirmations[0].resume_id, confirmationResumeId)
  assert.equal(confirmationEntry.submission_confirmation.confirmations[0].confirmation_source, 'unknown')
  assert.equal(confirmationEntry.submission_confirmation.confirmations[0].actual_submission_occurred_at, null)
  await sql(`update job_applications set company='snapshot changed after capture' where id='${snapshotApplicationId}';`)
  const replayedSnapshot = JSON.parse(await sql(`select get_application_evidence_snapshot_page('${snapshot.snapshot_id}',null,100);`))
  assert.equal(replayedSnapshot.applications.find(entry => entry.application.application_id === snapshotApplicationId).application.company, 'snapshot')
  assert.equal(await sql("select has_function_privilege('anon', 'public.create_application_evidence_snapshot()', 'execute');"), 'f')
  assert.equal(await sql("select has_function_privilege('service_role', 'public.get_application_evidence_snapshot_page(uuid,integer,integer)', 'execute');"), 't')
  console.log('PASS evidence snapshot: PostgreSQL materializes immutable JD evidence and restricts snapshot RPCs')

  // A VOLATILE function takes a fresh MVCC snapshot for its materialization
  // query, but statement_timestamp() remains the outer client command time.
  // Force a commit after that outer command and before the source query.
  await sql(`create function slow_snapshot_header() returns trigger language plpgsql as $$
    begin perform pg_sleep(1); return new; end; $$;
    create trigger slow_snapshot_header before insert on application_evidence_snapshots
    for each row execute function slow_snapshot_header();`)
  const delayedCapture = sql("set application_name='snapshot_delayed_header'; select create_application_evidence_snapshot();")
  await waitFor(countIsOne("select count(*) from pg_stat_activity where application_name='snapshot_delayed_header' and wait_event='PgSleep';"))
  const laterCommittedId = await sql("insert into job_applications(company,role) values ('committed_after_capture_command','test') returning id;")
  const delayedSnapshot = JSON.parse(await delayedCapture)
  const delayedPage = JSON.parse(await sql(`select get_application_evidence_snapshot_page('${delayedSnapshot.snapshot_id}',null,100);`))
  assert.ok(delayedPage.applications.some(entry => entry.application.application_id === laterCommittedId))
  assert.equal(await sql(`select (entry.evidence->'application'->>'created_at')::timestamptz <= snapshot.as_of
    from application_evidence_snapshots snapshot
    join application_evidence_snapshot_entries entry on entry.snapshot_id=snapshot.id
    where snapshot.id='${delayedSnapshot.snapshot_id}' and entry.application_id='${laterCommittedId}';`), 't',
  'materialization as_of must not predate a row committed after the outer command began')
  await sql('drop trigger slow_snapshot_header on application_evidence_snapshots; drop function slow_snapshot_header();')
  console.log('PASS evidence snapshot boundary: delayed source query timestamps its own materialization, not the outer command')

  // Each snapshot derives its total from the INSERT ... SELECT that materializes
  // entries, rather than from a separately timed count. Exercise that invariant
  // while another session creates applications between snapshot requests.
  const concurrentSnapshotWriter = sql(`set application_name='evidence_snapshot_writer'; do $$
    begin
      for n in 1..12 loop
        insert into job_applications(company, role, job_description)
        values ('snapshot_writer_' || n, 'test', 'writer JD ' || n);
        perform pg_sleep(0.05);
      end loop;
    end;
  $$;`)
  await waitFor(countIsOne("select count(*) from pg_stat_activity where application_name='evidence_snapshot_writer' and wait_event='PgSleep';"))
  const concurrentSnapshots = []
  for (let n = 0; n < 3; n++) concurrentSnapshots.push(JSON.parse(await sql('select create_application_evidence_snapshot();')).snapshot_id)
  await concurrentSnapshotWriter
  for (const snapshotId of concurrentSnapshots) {
    const reconciled = await sql(`select snapshot.total_applications || ':' || count(entry.application_id)
      from application_evidence_snapshots snapshot
      left join application_evidence_snapshot_entries entry on entry.snapshot_id = snapshot.id
      where snapshot.id = '${snapshotId}'
      group by snapshot.total_applications;`)
    const [total, entries] = reconciled.split(':').map(Number)
    assert.equal(total, entries)
    assert.equal(await sql(`select bool_and((entry.evidence->'application'->>'created_at')::timestamptz <= snapshot.as_of)
      from application_evidence_snapshots snapshot
      join application_evidence_snapshot_entries entry on entry.snapshot_id = snapshot.id
      where snapshot.id = '${snapshotId}';`), 't')
  }
  console.log('PASS evidence snapshot concurrency: each materialized count equals its own entry scope and declared as-of boundary during writes')

  // Force two independent sessions through the old check-then-insert window.
  // The second call must return the committed canonical event, not leak a
  // unique-constraint failure. This exercises PostgreSQL, not a mock RPC.
  const outcomeAppId = await sql("insert into job_applications(company,role) values ('outcome_replay','test') returning id;")
  const outcomeEventId = `imap:${'c'.repeat(64)}:321:654`
  const outcomeEvidenceHash = 'd'.repeat(64)
  await sql(`create function slow_outcome_replay() returns trigger language plpgsql as $$ begin perform pg_sleep(0.5); return new; end; $$;
    create trigger slow_outcome_replay before insert on application_observed_outcomes for each row execute function slow_outcome_replay();`)
  const outcomeSql = `select record_application_observed_outcome('${outcomeAppId}', 'granted_inbox', '${outcomeEventId}', 1, 'other_response', null, '${outcomeEventId}', '${outcomeEvidenceHash}', 'automated_ack', null, null);`
  const firstOutcome = sql(`set application_name='outcome_replay_first'; ${outcomeSql}`)
  await waitFor(countIsOne("select count(*) from pg_stat_activity where application_name='outcome_replay_first' and wait_event='PgSleep';"))
  const secondOutcome = sql(`set application_name='outcome_replay_second'; ${outcomeSql}`)
  const [firstOutcomeResult, secondOutcomeResult] = await Promise.all([firstOutcome, secondOutcome])
  const parsedOutcomeResults = [JSON.parse(firstOutcomeResult), JSON.parse(secondOutcomeResult)]
  assert.equal(parsedOutcomeResults[0].event_id, parsedOutcomeResults[1].event_id)
  assert.deepEqual(parsedOutcomeResults.map(result => result.idempotent).sort(), [false, true])
  assert.equal(await sql(`select payload_hash = encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_payload::text, 'UTF8')), 'hex')
    from application_observed_outcomes where application_id='${outcomeAppId}';`), 't')
  await sql('drop trigger slow_outcome_replay on application_observed_outcomes; drop function slow_outcome_replay();')

  const coverageEnd = '2020-01-04T00:00:00.000Z'
  const coverageRef = `imap-coverage:${'e'.repeat(64)}:987:${new Date(coverageEnd).getTime()}:0:0`
  await sql(`create function slow_coverage_replay() returns trigger language plpgsql as $$ begin perform pg_sleep(0.5); return new; end; $$;
    create trigger slow_coverage_replay before insert on application_outcome_check_observations for each row execute function slow_coverage_replay();`)
  const coverageSql = `select record_application_outcome_check('${outcomeAppId}', 'imap_inbox', 'concurrent-coverage', '2020-01-01T00:00:00Z', '${coverageEnd}', 'inbox_internaldate_v1', null, false, 'unknown', 0, 0, '${coverageRef}');`
  const firstCoverage = sql(`set application_name='coverage_replay_first'; ${coverageSql}`)
  await waitFor(countIsOne("select count(*) from pg_stat_activity where application_name='coverage_replay_first' and wait_event='PgSleep';"))
  const secondCoverage = sql(`set application_name='coverage_replay_second'; ${coverageSql}`)
  const [firstCoverageResult, secondCoverageResult] = await Promise.all([firstCoverage, secondCoverage])
  const parsedCoverageResults = [JSON.parse(firstCoverageResult), JSON.parse(secondCoverageResult)]
  assert.equal(parsedCoverageResults[0].check_id, parsedCoverageResults[1].check_id)
  assert.deepEqual(parsedCoverageResults.map(result => result.idempotent).sort(), [false, true])
  assert.equal(await sql(`select payload_hash = encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_payload::text, 'UTF8')), 'hex')
    from application_outcome_check_observations where application_id='${outcomeAppId}' and client_check_identity='concurrent-coverage';`), 't')
  await sql('drop trigger slow_coverage_replay on application_outcome_check_observations; drop function slow_coverage_replay();')
  console.log('PASS outcome replay concurrency: duplicate source event/check calls converge on one SHA-256-bound immutable record')

  for (const ending of ['commit', 'rollback']) {
    const before = await readFeed()
    const first = sql(`set application_name='feed_first'; begin;
      insert into job_applications(company,role) values ('first_${ending}','test');
      select pg_sleep(3); ${ending};`)
    await waitFor(countIsOne("select count(*) from pg_stat_activity where application_name='feed_first' and wait_event='PgSleep';"))
    const second = sql(`set application_name='feed_second';
      insert into job_applications(company,role) values ('second_${ending}','test');`)
    await waitFor(countIsOne("select count(*) from pg_stat_activity where application_name='feed_second' and wait_event='advisory';"))
    const during = await readFeed(before.next_cursor)
    assert.deepEqual(during.changes, [])
    assert.deepEqual(during.next_cursor, before.next_cursor)
    await Promise.all([first, second])
    const after = await readFeed(before.next_cursor)
    assert.deepEqual(after.changes.map(change => change.application.company),
      ending === 'commit' ? ['first_commit', 'second_commit'] : ['second_rollback'])
    assert.deepEqual((await readFeed(before.next_cursor)).changes, after.changes)
    console.log(`PASS ${ending}: blocked writer, unchanged pending cursor, exact replay`)
  }

  const beforeFailure = await readFeed()
  const failurePoint = 'create trigger job_pipeline_change'
  assert.ok(migration.includes(failurePoint))
  await assert.rejects(sql(migration.replace(failurePoint, `select 1/0;\n${failurePoint}`)), /division by zero/)
  assert.equal(Number(await sql("select count(*) from pg_trigger where tgname='job_pipeline_change' and tgrelid='job_applications'::regclass;")), 1)
  await sql("insert into job_applications(company,role) values ('after_failed_migration','test');")
  assert.deepEqual((await readFeed(beforeFailure.next_cursor)).changes.map(change => change.application.company), ['after_failed_migration'])
  console.log('PASS migration failure: prior trigger restored and subsequent write captured')

  const beforeReplay = await readFeed()
  const replay = sql(`set application_name='feed_migration';\n${migration.replace(failurePoint, `select pg_sleep(3);\n${failurePoint}`)}`)
  await waitFor(countIsOne("select count(*) from pg_stat_activity where application_name='feed_migration' and wait_event='PgSleep';"))
  const writer = sql("set application_name='feed_during_migration'; insert into job_applications(company,role) values ('during_migration','test');")
  await waitFor(countIsOne("select count(*) from pg_stat_activity where application_name='feed_during_migration' and wait_event_type='Lock';"))
  await Promise.all([replay, writer])
  assert.deepEqual((await readFeed(beforeReplay.next_cursor)).changes.map(change => change.application.company), ['during_migration'])
  console.log('PASS migration replay: concurrent writer waits and is journaled after commit')
  console.log('outcome=passed: nine PostgreSQL scenarios')
} finally {
  if (started) await run('docker', ['stop', container], options)
  console.log(`Isolated container retained: ${container}; started=${started}, stopped=${started}`)
}
