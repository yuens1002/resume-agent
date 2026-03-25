import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const url = process.env.SUPA_PROJECT_URL!
const key = process.env.SUPA_SERVICE_ROLE!

if (!url || !key) {
  console.error('Missing SUPA_PROJECT_URL or SUPA_SERVICE_ROLE in .env')
  process.exit(1)
}

const supabase = createClient(url, key)
const __dirname = dirname(fileURLToPath(import.meta.url))
const profile = JSON.parse(readFileSync(join(__dirname, 'seed-profile.json'), 'utf-8'))

const { data, error } = await supabase
  .from('public_profile')
  .update({ ...profile, updated_at: new Date().toISOString() })
  .eq('id', '00000000-0000-0000-0000-000000000001')
  .select()
  .single()

if (error) {
  console.error('Seed failed:', error.message)
  process.exit(1)
}

console.log('Seeded profile for:', data.contact?.name)
console.log('Projects:', data.projects?.length)
console.log('Employment:', data.employment?.length)
console.log('Skills categories:', data.skills?.length)
