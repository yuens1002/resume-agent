import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { invalidateProfileCache } from '../lib/profile-cache.js'

const app = new Hono()

// Always key-protected — this is a private write endpoint
app.use('*', async (c, next) => {
  const header = c.req.header('Authorization')
  const token = header?.replace('Bearer ', '')
  if (!token || token !== process.env.API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
})

const schema = z.object({
  contact:      z.record(z.unknown()).optional(),
  summary:      z.string().optional(),
  skills:       z.array(z.unknown()).optional(),
  employment:   z.array(z.unknown()).optional(),
  education:    z.array(z.unknown()).optional(),
  projects:     z.array(z.unknown()).optional(),
  availability: z.record(z.unknown()).optional(),
})

app.patch('/', zValidator('json', schema), async (c) => {
  const body = c.req.valid('json')

  // Strip undefined keys so we only update what was sent
  const updates = Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined)
  )

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No fields provided' }, 400)
  }

  const { data, error } = await supabase
    .from('public_profile')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .select()
    .single()

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  invalidateProfileCache()
  return c.json(data)
})

export default app
