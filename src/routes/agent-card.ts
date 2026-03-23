import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'

const app = new Hono()

// A2A-compliant agent card for autodiscovery by employer AI systems
app.get('/', async (c) => {
  const { data } = await supabase
    .from('public_profile')
    .select('contact, availability')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  const baseUrl = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`

  return c.json({
    schema_version: '1.0',
    name: data?.contact?.name ?? 'Resume Agent',
    description: 'AI agent representing a professional profile. Query skills, experience, and availability.',
    url: baseUrl,
    capabilities: ['query', 'match', 'info', 'availability'],
    endpoints: {
      info: `${baseUrl}/info`,
      availability: `${baseUrl}/availability`,
      query: `${baseUrl}/query`,
      match: `${baseUrl}/match`,
    },
    contact: {
      email: data?.contact?.email,
      calendly: data?.contact?.calendly,
    },
  })
})

export default app
