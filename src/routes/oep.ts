import { Hono } from 'hono'
import { buildEnvelope, loadPublicKeyFromEnv } from '../lib/oep-key.js'

const app = new Hono()

app.get('/', (c) => {
  let loaded
  try {
    loaded = loadPublicKeyFromEnv()
  } catch (err) {
    return c.json({ error: (err as Error).message }, 503)
  }
  if (!loaded) {
    return c.json({ error: 'OEP_PUBLIC_KEY is not configured on this agent' }, 503)
  }
  c.header('Cache-Control', 'public, max-age=300')
  return c.json(buildEnvelope(loaded))
})

export default app
