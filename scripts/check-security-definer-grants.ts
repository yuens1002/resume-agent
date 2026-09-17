// Closes #280-adjacent lesson (see #279's CHANGELOG entry): rotate_refresh_token was a
// `security definer` RPC directly callable by anon/authenticated via PostgREST for months
// before anyone noticed, because nothing checked for it — this repo's own revoke/grant
// convention (established 2026-09-12) was applied forward-only, never audited backward.
// This script is the backward audit, made permanent: it queries pg_proc directly for any
// `security definer` function in the public schema whose return type isn't trigger/
// event_trigger (those aren't directly callable via PostgREST or a plain SQL call, so an
// EXECUTE grant on them is inert) and that still has anon or authenticated EXECUTE.
//
// Run manually (`npm run check:rpc-grants`) or automatically after every `db:push`
// (wired as `postdb:push`), since a migration landing is the exact moment a new gap of
// this shape would be introduced.
import { spawnSync } from 'child_process'

const url = process.env.SUPA_DIRECT_CONNECTION_STRING
if (!url) throw new Error('SUPA_DIRECT_CONNECTION_STRING not set in .env.local')

const query = `
  select p.proname
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
  order by p.proname;
`

const result = spawnSync('psql', ['-d', url, '-t', '-A', '-c', query], { encoding: 'utf8' })
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
  for (const name of exposed) console.error(`  - ${name}`)
  console.error('\nAdd, in the same migration that creates or replaces the function:')
  console.error('  revoke all on function public.<name>(<sig>) from public, anon, authenticated;')
  console.error('  grant execute on function public.<name>(<sig>) to service_role;')
  process.exit(1)
}

console.log('✔ No security definer function is directly callable by anon/authenticated.')
