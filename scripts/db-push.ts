import { spawnSync } from 'child_process'

const url = process.env.SUPA_DIRECT_CONNECTION_STRING
if (!url) throw new Error('SUPA_DIRECT_CONNECTION_STRING is not set in .env.local')

const result = spawnSync('npx', ['supabase', 'db', 'push', '--db-url', url], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
