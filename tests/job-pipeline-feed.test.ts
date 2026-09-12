import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { JobFeedEnvelopeSchema, readJobPipelineFeed, type JobFeedEnvelope } from '../src/lib/job-pipeline-feed.js'
import { registerJobPipelineFeed } from '../src/lib/job-pipeline-feed-tool.js'

const migration = readFileSync('supabase/migrations/20260912000000_job_pipeline_feed.sql', 'utf8')
const original = readFileSync('supabase/migrations/20260329000000_job_hunt_pipeline.sql', 'utf8')
// PGlite lacks this optional index extension. Table/constraints/triggers/RLS
// and the entire new migration execute unchanged.
const baseline = original.replace(/^create extension if not exists pg_trgm;$/m, '')
  .replace(/^create index .*gin_trgm_ops.*;$/gm, '')
const db = new PGlite()
const queryFeed = async (cursor?: JobFeedEnvelope['next_cursor'], timezone = 'UTC') => {
  const response = await db.query<{ feed: unknown }>(
    'select public.get_job_pipeline_feed($1::uuid, $2::bigint, $3) as feed',
    [cursor?.generation ?? null, cursor?.sequence ?? null, timezone])
  return JobFeedEnvelopeSchema.parse(response.rows[0].feed)
}
const addApplication = async (followUp: string | null = null, stage = 'applied') => {
  const result = await db.query<{ id: string }>(
    'insert into job_applications(company, role, follow_up_date, stage) values ($1,$2,$3,$4) returning id',
    ['Synthetic company', 'Synthetic role', followUp, stage])
  return result.rows[0].id
}
before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.role() returns text language sql as $$ select current_user::text $$;")
  await db.exec(baseline)
  await db.exec("insert into job_applications(company, role) select 'Historical ' || n, 'Role' from generate_series(1, 150) n")
  await db.exec(migration)
})
after(() => db.close())

describe('job feed production SQL', () => {
  it('AC-01 baseline counts beyond the list cap without inventing history', async () => {
    const feed = await queryFeed()
    const count = await db.query<{ count: number }>('select count(*)::int as count from job_applications')
    assert.equal(feed.summary.recorded_applications, count.rows[0].count)
    assert.ok(feed.summary.recorded_applications > 100)
    assert.equal(feed.baseline, true)
    assert.deepEqual(feed.changes, [])
  })
  it('AC-02 captures changes, replays stable IDs, and records deletion without private notes', async () => {
    const start = await queryFeed()
    const id = await addApplication()
    await db.query("update job_applications set stage='phone_screen', follow_up_date=current_date-1, notes='PRIVATE' where id=$1", [id])
    await db.query('delete from job_applications where id=$1', [id])
    const feed = await queryFeed(start.next_cursor)
    assert.deepEqual(feed.changes.map(change => change.operation), ['INSERT', 'UPDATE', 'DELETE'])
    assert.ok(feed.changes.every(change => change.application_id === id))
    assert.equal(feed.changes[1].application.stage, 'phone_screen')
    assert.ok(!JSON.stringify(feed).includes('PRIVATE'))
    assert.deepEqual((await queryFeed(start.next_cursor)).changes, feed.changes)
    assert.deepEqual((await queryFeed(feed.next_cursor)).changes, [])
  })
  it('AC-02 rollback produces no change; later commits remain readable across sequence gaps', async () => {
    const start = await queryFeed()
    await db.exec('begin')
    await addApplication()
    await db.exec('rollback')
    assert.deepEqual((await queryFeed(start.next_cursor)).changes, [])
    const id = await addApplication()
    assert.equal((await queryFeed(start.next_cursor)).changes[0].application_id, id)
  })
  it('AC-03 due/overdue work survives no-change reads; future and terminal work excluded', async () => {
    const dates = await db.query<{ past: string; today: string; future: string }>("select (current_date-1)::text as past, current_date::text as today, (current_date+1)::text as future")
    const { past, today, future } = dates.rows[0]
    const overdue = await addApplication(past)
    const due = await addApplication(today, 'offer')
    const later = await addApplication(future)
    const rejected = await addApplication(past, 'rejected')
    const withdrawn = await addApplication(past, 'withdrawn')
    const start = await queryFeed()
    const feed = await queryFeed(start.next_cursor)
    assert.deepEqual(feed.changes, [])
    const dueIds = feed.due_work.map(application => application.application_id)
    assert.ok(dueIds.includes(overdue) && dueIds.includes(due))
    assert.ok(!dueIds.includes(later) && !dueIds.includes(rejected) && !dueIds.includes(withdrawn))
    // Same stored rows, different local date: time drives eligibility.
    const west = await queryFeed(start.next_cursor, 'Etc/GMT+12')
    const east = await queryFeed(start.next_cursor, 'Pacific/Kiritimati')
    assert.notDeepEqual(west.due_work, east.due_work)
    assert.deepEqual(west.changes, east.changes)
  })
  it('AC-04 rejects wrong generation, future sequence and invalid timezone', async () => {
    const feed = await queryFeed()
    await assert.rejects(queryFeed({ ...feed.next_cursor, generation: '00000000-0000-0000-0000-000000000000' }), /cursor/)
    await assert.rejects(queryFeed({ ...feed.next_cursor, sequence: '9223372036854775807' }), /cursor/)
    await assert.rejects(queryFeed(undefined, 'Invalid/Zone'), /timezone/)
  })
  it('AC-04 overflow refuses instead of checkpointing a truncated changes list', async () => {
    const start = await queryFeed()
    await db.exec("insert into job_applications(company, role) select 'Batch ' || n, 'Role' from generate_series(1, 1001) n")
    await assert.rejects(queryFeed(start.next_cursor), /exceeds/)
    assert.equal((await queryFeed()).baseline, true)
  })
  it('AC-04 due-work overflow also refuses on a baseline', async () => {
    await db.exec('begin')
    await db.exec('update job_applications set follow_up_date=current_date-2')
    await assert.rejects(queryFeed(), /exceeds/)
    await db.exec('rollback')
  })
  it('AC-04/06 public roles cannot execute the RPC or read journal; service role can', async () => {
    for (const role of ['anon', 'authenticated']) {
      const privilege = await db.query<{ allowed: boolean }>("select has_function_privilege($1, 'public.get_job_pipeline_feed(uuid,bigint,text)', 'execute') as allowed", [role])
      assert.equal(privilege.rows[0].allowed, false)
      await db.exec(`set role ${role}`)
      await assert.rejects(queryFeed(), /permission denied/)
      await assert.rejects(db.query('select * from job_pipeline_changes'), /permission denied/)
      await db.exec('reset role')
    }
    await db.exec('set role service_role')
    assert.ok((await queryFeed()).summary.recorded_applications > 100)
    await db.exec('reset role')
  })
  it('AC-01/04 rerunning migration preserves journal identity and records', async () => {
    await addApplication()
    const before = await queryFeed()
    const beforeJournal = await db.query('select * from job_pipeline_changes order by sequence')
    assert.ok(beforeJournal.rows.length > 0)
    await db.exec(migration)
    const after = await queryFeed()
    assert.deepEqual(after.next_cursor, before.next_cursor)
    assert.deepEqual(after.summary, before.summary)
    assert.deepEqual((await db.query('select * from job_pipeline_changes order by sequence')).rows, beforeJournal.rows)
  })
})

describe('job feed adapter and MCP registration', () => {
  it('AC-05 parses the actual SQL response and forwards input without acknowledging', async () => {
    const feed = await queryFeed()
    const timezone = 'Pacific/Kiritimati'
    const result = await readJobPipelineFeed({ cursor: feed.next_cursor, timezone }, async (name, args) => {
      assert.equal(name, 'get_job_pipeline_feed')
      assert.deepEqual(args, { p_generation: feed.next_cursor.generation, p_after_sequence: feed.next_cursor.sequence, p_timezone: timezone })
      const response = await db.query<{ feed: unknown }>('select get_job_pipeline_feed($1::uuid,$2::bigint,$3) as feed', [args.p_generation, args.p_after_sequence, args.p_timezone])
      return { data: response.rows[0].feed, error: null }
    })
    assert.equal(result.status, 'ok')
  })
  it('AC-05 refusals never return a cursor', async () => {
    const cases = [
      await readJobPipelineFeed({ cursor: { generation: 'bad', sequence: '-1' } }, async () => { throw Error('must not call') }),
      await readJobPipelineFeed({}, async () => ({ data: {}, error: null })),
      await readJobPipelineFeed({}, async () => ({ data: null, error: { code: '54000' } })),
      await readJobPipelineFeed({}, async () => { throw Error('private connection details') }),
    ]
    for (const result of cases) {
      assert.equal(result.status, 'refused')
      assert.ok(!JSON.stringify(result).includes('cursor') && !JSON.stringify(result).includes('private connection'))
    }
  })
  it('AC-05 malformed inputs refuse without invoking RPC', async () => {
    let calls = 0
    const rpc = async () => { calls++; return { data: null, error: null } }
    const generation = (await queryFeed()).next_cursor.generation
    for (const sequence of ['abc', '1.5', '-1', '01', '9223372036854775808']) {
      assert.deepEqual(await readJobPipelineFeed({ cursor: { generation, sequence } }, rpc), { status: 'refused', code: 'invalid_input' })
    }
    assert.deepEqual(await readJobPipelineFeed({ cursor: { generation: 'invalid', sequence: '0' } }, rpc), { status: 'refused', code: 'invalid_input' })
    assert.equal(calls, 0)
  })
  it('AC-06 real MCP tools/list and tools/call exercise registered code', async () => {
    const server = new McpServer({ name: 'test', version: '1' })
    let calls = 0
    registerJobPipelineFeed(server, async () => { calls++; return { data: await queryFeed(), error: null } })
    const client = new Client({ name: 'test-client', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const listing = await client.listTools()
      assert.ok(listing.tools.some(tool => tool.name === 'get_job_pipeline_feed'))
      const response = await client.callTool({ name: 'get_job_pipeline_feed', arguments: {} })
      assert.equal(response.isError, false)
      const content = response.content as { text: string }[]
      assert.equal(JSON.parse(content[0].text).status, 'ok')
      JobFeedEnvelopeSchema.parse(JSON.parse(content[0].text).feed)
      const callsBefore = calls
      const invalid = await client.callTool({ name: 'get_job_pipeline_feed', arguments: { cursorr: { generation: 'bad', sequence: '0' } } })
      assert.equal(invalid.isError, true)
      assert.equal(calls, callsBefore)
    } finally { await client.close(); await server.close() }
  })
})
