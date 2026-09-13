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
  await sql("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.role() returns text language sql as $$ select current_user::text $$;")
  await sql(baseline)
  await sql(migration)

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
  console.log('outcome=passed: four PostgreSQL scenarios')
} finally {
  if (started) await run('docker', ['stop', container], options)
  console.log(`Isolated container retained: ${container}; started=${started}, stopped=${started}`)
}
