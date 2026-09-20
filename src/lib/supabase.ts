import './env.js'
import { createClient } from '@supabase/supabase-js'
import { createBoundedFetch } from './bounded-fetch.js'

const url = process.env.SUPA_PROJECT_URL
const key = process.env.SUPA_SERVICE_ROLE

if (!url || !key) {
  throw new Error('Missing SUPA_PROJECT_URL or SUPA_SERVICE_ROLE')
}

// Every call through the shared client is time-bounded (SUPABASE_FETCH_TIMEOUT_MS)
// so a degraded database fails requests instead of holding them open (#286).
export const supabase = createClient(url, key, {
  global: { fetch: createBoundedFetch() },
})
