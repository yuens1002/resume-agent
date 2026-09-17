import { spawnSync } from 'child_process'
import { readdirSync } from 'fs'
import { resolve } from 'path'
import { runSecurityDefinerGrantsAudit } from './check-security-definer-grants.js'

const url = process.env.SUPA_DIRECT_CONNECTION_STRING
if (!url) throw new Error('SUPA_DIRECT_CONNECTION_STRING not set in .env.local')

const migrations = readdirSync('supabase/migrations')
  .filter(f => f.endsWith('.sql'))
  .sort()

// Runs the security-definer grants audit itself, from a finally block, rather than as an
// npm postdb:push lifecycle hook — npm only runs a post-hook when the preceding script exits
// 0, so a migration that partially applies (an earlier file in this loop commits its function
// definition, then a later file fails) would otherwise skip the audit entirely, silently
// leaving whatever grant gap that partial state introduced unchecked (a Copilot review
// comment on #282 caught this). Calls the audit in-process rather than spawning it as a
// separate `npx tsx ...` subprocess, since that needs `shell: true` on Windows (npx is a
// .cmd shim there) to avoid an ENOENT.
let exitCode = 0
try {
  for (const file of migrations) {
    console.log(`→ ${file}`)
    const r = spawnSync('psql', ['-d', url, '-v', 'ON_ERROR_STOP=1', '-f', resolve('supabase/migrations', file)], { stdio: 'inherit' })
    if (r.error) {
      console.error(`Failed to launch psql: ${r.error.message}`)
      exitCode = 1
      break
    }
    if (r.status !== 0) {
      exitCode = r.status ?? 1
      break
    }
  }
} finally {
  console.log('\n→ Auditing security-definer RPC grants')
  const auditExitCode = runSecurityDefinerGrantsAudit()
  if (exitCode === 0) exitCode = auditExitCode
}

process.exit(exitCode)
