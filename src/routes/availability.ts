import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'

const app = new Hono()

app.get('/', async (c) => {
  const { data, error } = await supabase
    .from('public_profile')
    .select('availability, contact, updated_at')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error) {
    return c.json({ error: 'Profile not found' }, 404)
  }

  return c.json({
    availability: data.availability,
    contact: {
      email: data.contact?.email,
      calendly: data.contact?.calendly,
    },
    updated_at: data.updated_at,
  })
})

export default app
