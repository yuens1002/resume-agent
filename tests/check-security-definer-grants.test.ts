/**
 * Tests the literal SQL query scripts/check-security-definer-grants.ts runs against the live
 * database — not a reimplementation of it, so a regression in the real query (role checks,
 * trigger exclusion, overload signature formatting, the trigger/event_trigger type-name-vs-OID
 * fix) fails here the same way it would in production, rather than passing a duplicated query
 * that drifted from the real one.
 *
 * Uses PGlite (in-memory Postgres) rather than the live Supabase database: this needs full
 * control over which functions exist and what's granted to which role, which a shared live
 * database can't safely offer per test run.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { SECURITY_DEFINER_GRANTS_QUERY } from '../scripts/check-security-definer-grants.js'

const db = new PGlite()

async function exposedSignatures(): Promise<string[]> {
  const result = await db.query<{ signature: string }>(SECURITY_DEFINER_GRANTS_QUERY)
  return result.rows.map(row => row.signature)
}

before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role;')
})
after(() => db.close())

describe('security-definer grants audit query', () => {
  it('flags a security definer function directly granted to anon', async () => {
    await db.exec(`
      create function public.vulnerable_direct_grant() returns json language sql security definer as $$ select '{}'::json $$;
      grant execute on function public.vulnerable_direct_grant() to anon;
    `)
    assert.ok((await exposedSignatures()).includes('vulnerable_direct_grant()'))
  })

  it('flags a security definer function left at its PUBLIC-default grant (never revoked)', async () => {
    // Postgres grants EXECUTE to PUBLIC on a new function by default — this is the exact
    // shape rotate_refresh_token had for months (#279): no explicit grant to anon at all,
    // just never revoked from PUBLIC, which anon and authenticated both inherit from.
    await db.exec(`
      create function public.vulnerable_public_default() returns json language sql security definer as $$ select '{}'::json $$;
    `)
    assert.ok((await exposedSignatures()).includes('vulnerable_public_default()'))
  })

  it('does not flag a function with EXECUTE properly revoked and granted only to service_role', async () => {
    await db.exec(`
      create function public.safe_locked_down() returns json language sql security definer as $$ select '{}'::json $$;
      revoke all on function public.safe_locked_down() from public, anon, authenticated;
      grant execute on function public.safe_locked_down() to service_role;
    `)
    assert.ok(!(await exposedSignatures()).includes('safe_locked_down()'))
  })

  it('does not flag a security invoker function even if granted to anon', async () => {
    await db.exec(`
      create function public.safe_not_definer() returns json language sql as $$ select '{}'::json $$;
      grant execute on function public.safe_not_definer() to anon;
    `)
    assert.ok(!(await exposedSignatures()).includes('safe_not_definer()'))
  })

  it('does not flag a trigger function granted to anon (not invocable via PostgREST or plain SQL)', async () => {
    await db.exec(`
      create function public.vulnerable_shaped_trigger() returns trigger language plpgsql security definer as $$ begin return new; end; $$;
      grant execute on function public.vulnerable_shaped_trigger() to anon;
    `)
    assert.ok(!(await exposedSignatures()).includes('vulnerable_shaped_trigger()'))
  })

  it('does not flag an event trigger function granted to anon', async () => {
    await db.exec(`
      create function public.vulnerable_shaped_event_trigger() returns event_trigger language plpgsql security definer as $$ begin end; $$;
      grant execute on function public.vulnerable_shaped_event_trigger() to anon;
    `)
    assert.ok(!(await exposedSignatures()).includes('vulnerable_shaped_event_trigger()'))
  })

  it('flags a function whose return type is a user-defined type merely NAMED "trigger", distinct from the pg_catalog pseudo-type', async () => {
    // The exact bug a Copilot review caught on #282: comparing by type NAME alone
    // (t.typname not in ('trigger', 'event_trigger')) is ambiguous, since type names are
    // only unique per-namespace. A real, callable, exploitable function returning a
    // same-named-but-different type would silently pass as "just a trigger function."
    // The fix compares prorettype against pg_catalog's actual trigger/event_trigger OIDs.
    await db.exec(`
      create schema type_collision_ns;
      create type type_collision_ns.trigger as (x int);
      create function public.vulnerable_type_name_collision() returns type_collision_ns.trigger language sql security definer as $$ select row(1)::type_collision_ns.trigger $$;
      grant execute on function public.vulnerable_type_name_collision() to anon;
    `)
    assert.ok((await exposedSignatures()).includes('vulnerable_type_name_collision()'))
  })

  it('disambiguates overloaded signatures, catching only the vulnerable overload by its exact signature', async () => {
    await db.exec(`
      create function public.overloaded_rpc(a text) returns json language sql security definer as $$ select '{}'::json $$;
      revoke all on function public.overloaded_rpc(text) from public, anon, authenticated;
      grant execute on function public.overloaded_rpc(text) to service_role;

      create function public.overloaded_rpc(a integer) returns json language sql security definer as $$ select '{}'::json $$;
      grant execute on function public.overloaded_rpc(integer) to anon;
    `)
    const signatures = await exposedSignatures()
    assert.ok(!signatures.includes('overloaded_rpc(text)'))
    assert.ok(signatures.some(s => s.startsWith('overloaded_rpc(') && s.includes('integer')))
  })
})
