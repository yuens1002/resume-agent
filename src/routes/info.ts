import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'

const app = new Hono()

app.get('/', async (c) => {
  const { data, error } = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error) {
    return c.json({ error: 'Profile not found' }, 404)
  }

  return c.json(data)
})

export default app
