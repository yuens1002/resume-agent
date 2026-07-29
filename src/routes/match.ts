import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { scoreMatch, ProfileNotFoundError, ProfileUnavailableError } from '../lib/score-match.js'
import { PROFILE_ERROR_HTTP } from '../lib/profile-cache.js'
import { detectCaller } from '../lib/detect-caller.js'

const app = new Hono()

const schema = z.object({
  job_description: z.string().min(1),
})

/**
 * GET /match — self-descriptor for an endpoint that only answers POST (#223).
 *
 * `llms.txt` advertises `POST https://…/match` and `robots.txt` invites crawlers,
 * so anything following the advertised URL arrives here with a GET. It used to
 * get a bare 13-byte `404 Not Found` — no method hint, no schema, no pointer to
 * the working call, handed to exactly the audience this machine surface exists
 * for. Mirrors the descriptor `GET /query` has always returned, in the same
 * shape (`endpoint`, `method`, `description`, `body`, `response`, `example`), so
 * every advertised POST endpoint answers a GET the same way.
 *
 * 200 rather than 405: consistency with `/query` (and friendliness to naive
 * crawlers) wins over the more literally correct status, per the deliberate call
 * in #223. `/public-mcp` is the one exception — see its own GET handler, where a
 * real MCP client asking for an SSE stream still gets the spec's 405.
 */
app.get('/', (c) => {
  const url = new URL(c.req.url)
  c.header('Cache-Control', 'public, max-age=3600')
  return c.json({
    endpoint: url.pathname,
    method: 'POST',
    description: 'Score this candidate against a job description. Returns a structured fit assessment — score, matched strengths, gaps, and a recommended action — reasoned over the candidate\'s canonical published profile, not keyword-matched.',
    body: {
      job_description: 'string (required) — the full job description text',
    },
    response: 'application/json — { fit_score, matched, gaps, verdict, recommended_action }',
    example: {
      job_description: 'Senior Full-Stack Engineer (Remote) — 5+ years with TypeScript, React, and Node.js. Own features end-to-end, from schema to UI.',
    },
    // Relative, like /query's own descriptor — no dependence on PUBLIC_URL or
    // on the proxy presenting the right origin.
    related: {
      ask_a_question: 'POST /query',
      machine_schema: 'GET /openapi.json',
    },
  })
})

app.post('/', zValidator('json', schema), async (c) => {
  const { job_description } = c.req.valid('json')
  const caller = detectCaller(c)

  let result
  try {
    result = await scoreMatch(job_description, caller.hint)
  } catch (e) {
    if (e instanceof ProfileNotFoundError) {
      return c.json(PROFILE_ERROR_HTTP.not_found.body, PROFILE_ERROR_HTTP.not_found.status)
    }
    if (e instanceof ProfileUnavailableError) {
      return c.json(PROFILE_ERROR_HTTP.unavailable.body, PROFILE_ERROR_HTTP.unavailable.status)
    }
    return c.json({ error: 'Failed to score match' }, 500)
  }

  if (!result) {
    return c.json({ error: 'Failed to score match' }, 500)
  }

  return c.json(result)
})

export default app
