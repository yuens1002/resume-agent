import { execSync } from 'child_process'

const url = process.env.SUPA_DIRECT_CONNECTION_STRING
if (!url) throw new Error('SUPA_DIRECT_CONNECTION_STRING is not set in .env.local')

execSync(`npx supabase db push --db-url "${url}"`, { stdio: 'inherit' })
