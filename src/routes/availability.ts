import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'

const app = new Hono()

app.get('/', async (c) => {
  const { data, error } = await supabase
    .from('public_profile')
    .select('availability, contact, updated_at')
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
