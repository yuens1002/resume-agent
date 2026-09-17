// Closes #279's own follow-up lesson: rotate_refresh_token was a `security definer` RPC
// directly callable by anon/authenticated via PostgREST for months before anyone noticed,
// because nothing checked for it — this repo's own revoke/grant convention (established
// 2026-09-12) was applied forward-only, never audited backward.
//
// This script is the backward audit, made permanent: it queries pg_proc directly for any
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
// Run manually (`npm run check:rpc-grants`) or automatically after every `db:push`
// (wired as `postdb:push`), since a migration landing is the exact moment a new gap of
// this shape would be introduced.
import { spawnSync } from 'child_process'

const url = process.env.SUPA_DIRECT_CONNECTION_STRING
if (!url) throw new Error('SUPA_DIRECT_CONNECTION_STRING not set in .env.local')

const query = `
  select p.oid::regprocedure::text as signature
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_type t on t.oid = p.prorettype
  where n.nspname = 'public'
    and p.prosecdef = true
    and t.typname not in ('trigger', 'event_trigger')
    and (
      has_function_privilege('anon', p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute')
    )
  order by signature;
`

// -X ignores ~/.psqlrc — a user's \x (expanded output) or \pset format would otherwise
// corrupt the "one bare line per row" parse below (e.g. html format emits table tags even
// for zero rows, a false positive this script would have no way to detect).
const result = spawnSync('psql', ['-X', '-d', url, '-t', '-A', '-c', query], { encoding: 'utf8' })
if (result.error) {
  console.error(`Failed to launch psql: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(result.stderr)
  process.exit(result.status ?? 1)
}

const exposed = result.stdout.split('\n').map(line => line.trim()).filter(Boolean)

if (exposed.length > 0) {
  console.error('✖ security definer function(s) directly callable by anon/authenticated:')
  for (const signature of exposed) console.error(`  - ${signature}`)
  console.error('\nAdd, in the same migration that creates or replaces the function:')
  console.error('  revoke all on function <signature> from public, anon, authenticated;')
  console.error('  grant execute on function <signature> to service_role;')
  process.exit(1)
}

console.log('✔ No security definer function is directly callable by anon/authenticated.')
