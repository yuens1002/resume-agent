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
  const r = spawnSync('psql', [url, '-f', resolve('supabase/migrations', file)], { stdio: 'inherit' })
  if (r.status) process.exit(r.status)
}
