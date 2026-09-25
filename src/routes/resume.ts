import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { fetchProfile, PROFILE_ERROR_HTTP } from '../lib/profile-cache.js'
import { PASS_THRESHOLD } from '../lib/score-resume.js'
import { filterVisibleProjects } from '../lib/hidden-projects.js'
import { generateResume, RESUME_MODEL, RESUME_MODEL_B } from '../lib/generate-resume.js'

// Re-exported for backward compatibility — the shared implementation now
// lives in src/lib/hidden-projects.ts (#176), but existing tests and any
// other consumers still import it from here.
export { filterVisibleProjects }

const app = new Hono()

const schema = z.object({
  job_description: z.string().min(1),
  framing_hints: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
})

// Private endpoint — requires Authorization: Bearer header
app.use('/', async (c, next) => {
  const authMode = process.env.AUTH_MODE ?? 'open'
  if (authMode === 'key') {
    const header = c.req.header('Authorization')
    const token = header?.replace('Bearer ', '')
    if (token !== process.env.API_KEY) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }
  await next()
})

type ProfileProject = { slug: string; name?: string; url?: string | null; repo?: string | null }

const normalizeName = (s: string) =>
  s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()

export function injectProjectUrls(
  generated: import('../types.js').Project[] | undefined,
  profileProjects: unknown,
): import('../types.js').Project[] {
  if (!generated?.length || !Array.isArray(profileProjects) || !profileProjects.length) {
    return generated ?? []
  }
  const valid = (profileProjects as unknown[]).filter(
    (p): p is ProfileProject =>
      p !== null && typeof p === 'object' && typeof (p as ProfileProject).slug === 'string'
  )
  const bySlug = new Map(valid.map(p => [p.slug, p]))
  const byName = new Map(
    valid
      .filter(p => typeof p.name === 'string' && p.name.trim().length > 0)
      .map(p => [normalizeName(p.name!), p])
  )

  return generated.map(p => {
    const nameKey = typeof p.name === 'string' && p.name.trim() ? normalizeName(p.name) : undefined
    const src = bySlug.get(p.slug) ?? (nameKey ? byName.get(nameKey) : undefined)
    if (!src) return p
    return { ...p, url: src.url || undefined, repo: src.repo || undefined }
  })
}

/**
 * Metadata stamped on the rubric-failure telemetry row written below.
 *
 * `private: true` is the load-bearing part. These rows embed the first 200
 * characters of the submitted job description, and without the flag they are
 * public-eligible — `isPublicThought` treats a missing `private` as public, so
 * an unstamped row is readable at `GET /observations?topic=rubric` by anyone
 * who guesses the tag. That was live: 100+ rows carrying real employer JD text
 * were publicly crawlable. The flag keeps them fully visible to the owner via
 * the private MCP while removing them from every public surface.
 *
 * `source: 'telemetry'` names the producer so the `/observations` authored vs
 * machine split (#222) classifies these explicitly rather than by the absence
 * of a field.
 *
 * Exported as a frozen constant so the privacy invariant is unit-testable
 * without driving a full résumé generation, and so a future edit to this object
 * trips a test rather than silently republishing job descriptions. `topics` is
 * frozen separately — `Object.freeze` is shallow, and an unfrozen nested array
 * would leave a `.push()` free to mutate the constant every later write reads
 * from.
 */
export const RUBRIC_FAILURE_METADATA = Object.freeze({
  type: 'observation',
  source: 'telemetry',
  private: true,
  topics: Object.freeze(['resume-failure', 'rubric']),
} as const)

app.post('/', zValidator('json', schema), async (c) => {
  const { job_description, framing_hints } = c.req.valid('json')

  const profileResult = await fetchProfile()

  if (profileResult.kind !== 'ok') {
    const { status, body } = PROFILE_ERROR_HTTP[profileResult.kind]
    return c.json(body, status)
  }
  const profile = profileResult.profile


  // ── SSE stream — sends first bytes immediately so Railway's proxy never times out ──

  const encoder = new TextEncoder()
  let streamController!: ReadableStreamDefaultController<Uint8Array>

  const sseBody = new ReadableStream<Uint8Array>({
    start(ctrl) { streamController = ctrl },
  })

  const send = (data: string) => {
    try { streamController.enqueue(encoder.encode(data)) } catch {}
  }

  // Flush first byte immediately so Railway's proxy doesn't 503 before the interval fires
  send(': keepalive\n\n')

  // ── Background: thoughts → prompt → dual LLM → score → respond ──
  ;(async () => {
    const keepalive = setInterval(() => send(': keepalive\n\n'), 10_000)

    try {
      const candidates = await generateResume({ profile, jobDescription: job_description, framingHints: framing_hints })

      if (candidates.length === 0) {
        send(`data: ${JSON.stringify({ error: 'Both resume generations failed to parse' })}\n\n`)
        return
      }

      const winner = candidates[0]

      if (!winner.rubric.passed) {
        const failures = winner.rubric.rules.filter(r => !r.pass)
        console.warn(
          `[resume] Neither generation passed rubric (best: ${winner.rubric.total.toFixed(1)}/${PASS_THRESHOLD}). ` +
          `Failures: ${failures.map(f => `Rule ${f.rule}: ${f.detail}`).join('; ')}`,
        )
        try {
          const failureThought = [
            `RESUME_RUBRIC_FAILURE: best_score=${winner.rubric.total.toFixed(1)}/${PASS_THRESHOLD}`,
            ...failures.map(f => `Rule ${f.rule} (${f.name}): ${f.detail}`),
            `JD: ${job_description.slice(0, 200).replace(/\n/g, ' ')}`,
          ].join(' | ')
          await supabase.from('thoughts').insert({
            content: failureThought,
            metadata: { ...RUBRIC_FAILURE_METADATA, topics: [...RUBRIC_FAILURE_METADATA.topics] },
          })
        } catch (err) {
          console.error('[resume] Failed to log rubric failure to OB1:', err instanceof Error ? err.message : err)
        }
      }

      winner.resume.contact = profile.contact

      // Inject url/repo from profile projects — LLMs reliably omit optional URL fields.
      // Profile is authoritative: always prefer profile values over whatever the model returned.
      winner.resume.projects = injectProjectUrls(winner.resume.projects, profile.projects)

      send(`data: ${JSON.stringify({
        ...winner.resume,
        _rubric: {
          total: Math.round(winner.rubric.total * 100) / 100,
          passed: winner.rubric.passed,
          jd_term_count: winner.rubric.jd_term_count,
          post_filtered: true,
          winner_model: winner.model,
          models: [RESUME_MODEL, RESUME_MODEL_B],
          rules: winner.rubric.rules.map(r => ({
            rule: r.rule,
            name: r.name,
            pass: r.pass,
            score: Math.round(r.score * 100) / 100,
            detail: r.detail,
          })),
          candidates_scored: candidates.length,
        },
      })}\n\n`)
    } catch (err) {
      console.error('[resume] Unexpected error:', err instanceof Error ? err.message : err)
      send(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`)
    } finally {
      clearInterval(keepalive)
      try { streamController.close() } catch {}
    }
  })()

  return new Response(sseBody, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
})

export default app
