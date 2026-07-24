import { Hono } from 'hono'
import { fetchProfile, PROFILE_ERROR_HTTP } from '../lib/profile-cache.js'

const app = new Hono()

app.get('/', async (c) => {
  const result = await fetchProfile()

  if (result.kind !== 'ok') {
    const { status, body } = PROFILE_ERROR_HTTP[result.kind]
    return c.json(body, status)
  }

  const { availability, contact, updated_at } = result.profile

  return c.json({
    availability,
    contact: {
      email: contact?.email,
      calendly: contact?.calendly,
    },
    updated_at,
  })
})

export default app
