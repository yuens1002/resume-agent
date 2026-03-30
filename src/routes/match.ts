import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { scoreMatch, ProfileNotFoundError } from '../lib/score-match.js'
import { detectCaller } from '../lib/detect-caller.js'

const app = new Hono()

const schema = z.object({
  job_description: z.string().min(1),
})

app.post('/', zValidator('json', schema), async (c) => {
  const { job_description } = c.req.valid('json')
  const caller = detectCaller(c)

  let result
  try {
    result = await scoreMatch(job_description, caller.hint)
  } catch (e) {
    if (e instanceof ProfileNotFoundError) {
      return c.json({ error: 'Profile not found' }, 404)
    }
    return c.json({ error: 'Failed to score match' }, 500)
  }

  if (!result) {
    return c.json({ error: 'Failed to score match' }, 500)
  }

  return c.json(result)
})

export default app
