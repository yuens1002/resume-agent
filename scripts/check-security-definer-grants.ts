// Closes #279's own follow-up lesson: rotate_refresh_token was a `security definer` RPC
// directly callable by anon/authenticated via PostgREST for months before anyone noticed,
// because nothing checked for it — this repo's own revoke/grant convention (established
// 2026-09-12) was applied forward-only, never audited backward.
//
// This script audits ordinary, callable functions (`prokind = 'f'`) only — a `security
// definer` PROCEDURE (invoked via CALL, not a plain function call) is a structurally
// different, less common shape this repo has none of today, but including one here would
// wrongly flag it as a PostgREST-reachable RPC gap. It queries pg_proc directly for any
// `security definer` function in the public schema whose return type isn't trigger/
// event_trigger (those aren't directly callable via PostgREST or a plain SQL call, so an
// EXECUTE grant on them is inert) and that still has anon or authenticated EXECUTE.
// Scoped to the `public` schema only — Supabase's other PostgREST-exposed schemas
// (`graphql_public`, `storage`) hold no repo-owned functions today; widen the `nspname`
// filter below if that changes. No allowlist for an intentionally anon/authenticated-callable
// security-definer RPC (e.g. one gated on auth.uid()) — this repo's own convention (see
// README's security model) is that every such function is service_role-only, so there's
// currently nothing to allow.
//
// SECURITY_DEFINER_GRANTS_QUERY is exported so tests/check-security-definer-grants.test.ts
// can run the literal same query against a PGlite instance with synthetic vulnerable/safe
// functions — this script's own psql-based run against the live database only proves "no
// gap today," not that the query itself would actually catch a real one. runSecurityDefinerGrantsAudit
// is exported so scripts/db-push.ts can call it in-process from its own finally block —
// spawning it as a separate `npx tsx ...` subprocess instead would need `shell: true` on
// Windows (npx is a .cmd shim there; spawnSync fails with ENOENT without it), and calling
// it directly avoids that entirely.
//
// Run manually (`npm run check:rpc-grants`) or automatically after every `db:push`
// (scripts/db-push.ts calls runSecurityDefinerGrantsAudit() itself, from a finally block —
// not an npm postdb:push lifecycle hook, since that would skip the audit on a
// partially-applied migration), since a migration landing is the exact moment a new gap of
// this shape would be introduced.
import { spawnSync } from 'child_process'

export const SECURITY_DEFINER_GRANTS_QUERY = `
  select p.oid::regprocedure::text as signature
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef = true
    and p.prokind = 'f'
    and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
    and (
      has_function_privilege('anon', p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute')
    )
  order by signature;
`

/** Returns an exit code (0 clean, 1 exposed or failed) rather than calling process.exit()
 *  itself, so a caller running this in-process (scripts/db-push.ts) can decide what to do
 *  with the result instead of having its own process killed out from under it. */
export function runSecurityDefinerGrantsAudit(): number {
  const url = process.env.SUPA_DIRECT_CONNECTION_STRING
  if (!url) throw new Error('SUPA_DIRECT_CONNECTION_STRING not set in .env.local')

  // -X ignores ~/.psqlrc — a user's \x (expanded output) or \pset format would otherwise
  // corrupt the "one bare line per row" parse below (e.g. html format emits table tags even
  // for zero rows, a false positive this script would have no way to detect).
  const result = spawnSync('psql', ['-X', '-d', url, '-t', '-A', '-c', SECURITY_DEFINER_GRANTS_QUERY], { encoding: 'utf8' })
  if (result.error) {
    console.error(`Failed to launch psql: ${result.error.message}`)
    return 1
  }
  if (result.status !== 0) {
    console.error(result.stderr)
    return result.status ?? 1
  }

  const exposed = result.stdout.split('\n').map(line => line.trim()).filter(Boolean)

  if (exposed.length > 0) {
    console.error('✖ security definer function(s) directly callable by anon/authenticated:')
    for (const signature of exposed) console.error(`  - ${signature}`)
    console.error('\nAdd, in the same migration that creates or replaces the function:')
    console.error('  revoke all on function <signature> from public, anon, authenticated;')
    console.error('  grant execute on function <signature> to service_role;')
    return 1
  }

  console.log('✔ No security definer function is directly callable by anon/authenticated.')
  return 0
}

const isMain = import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (isMain) process.exit(runSecurityDefinerGrantsAudit())
