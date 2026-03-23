import './env.js'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPA_PROJECT_URL
const key = process.env.SUPA_SERVICE_ROLE

if (!url || !key) {
  throw new Error('Missing SUPA_PROJECT_URL or SUPA_SERVICE_ROLE')
}

export const supabase = createClient(url, key)
