import { spawnSync } from 'child_process'
import { readdirSync } from 'fs'
import { resolve } from 'path'

const url = process.env.SUPA_DIRECT_CONNECTION_STRING
if (!url) throw new Error('SUPA_DIRECT_CONNECTION_STRING not set in .env.local')

const migrations = readdirSync('supabase/migrations')
  .filter(f => f.endsWith('.sql'))
  .sort()

for (const file of migrations) {
  console.log(`→ ${file}`)
  const r = spawnSync('psql', ['-d', url, '-v', 'ON_ERROR_STOP=1', '-f', resolve('supabase/migrations', file)], { stdio: 'inherit' })
  if (r.error) {
    console.error(`Failed to launch psql: ${r.error.message}`)
    process.exit(1)
  }
  if (r.status !== 0) process.exit(r.status ?? 1)
}
