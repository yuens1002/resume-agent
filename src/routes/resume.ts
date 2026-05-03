import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { getModel } from '../lib/ai.js'
import { generateText } from 'ai'
import { parseJSON } from '../lib/parse-json.js'
import { scoreResume, PASS_THRESHOLD, type RubricResult } from '../lib/score-resume.js'
import { stripBannedPhrases } from '../lib/strip-banned.js'
import { queryRelevantThoughts } from '../lib/thoughts-query.js'
import type { ResumeResponse } from '../types.js'

const RESUME_MODEL = process.env.RESUME_MODEL ?? 'openai/gpt-4o-mini'
const RESUME_MODEL_B = process.env.RESUME_MODEL_B ?? RESUME_MODEL
const HIDE_FROM_PROJECTS = new Set(
  (process.env.HIDE_FROM_PROJECTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
)

export function filterVisibleProjects(projects: unknown, hidden: Set<string>): unknown {
  if (!Array.isArray(projects) || hidden.size === 0) return projects
  return (projects as unknown[]).filter(
    (p): p is import('../types.js').Project =>
      p !== null && typeof p === 'object' &&
      typeof (p as { slug?: unknown }).slug === 'string' &&
      !hidden.has((p as { slug: string }).slug)
  )
}

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
  const byName = new Map(valid.filter(p => p.name).map(p => [normalizeName(p.name!), p]))

  return generated.map(p => {
    const src = bySlug.get(p.slug) ?? byName.get(normalizeName(p.name ?? ''))
    if (!src) return p
    return { ...p, url: src.url || undefined, repo: src.repo || undefined }
  })
}

app.post('/', zValidator('json', schema), async (c) => {
  const { job_description, framing_hints } = c.req.valid('json')

  const { data: profile, error } = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error || !profile) {
    return c.json({ error: 'Profile not found' }, 404)
  }

  const systemPrompt = `You are a professional resume writer optimizing for ATS (Applicant Tracking Systems) and human recruiter review. Generate a tailored resume for the candidate based on their profile and the target job description.

Rules:

1. SUMMARY — JD TITLE FIRST: Your opening words in the summary MUST use the exact job title from the job description, not the candidate's default self-description. Follow with years of experience and 3-5 high-priority skills from the JD woven naturally.
   Example: If JD says "Sr UX Engineer", open with "Senior UX Engineer with 6+ years..." — never "Full-stack engineer".

2. KEYWORD COVERAGE: Achieve at least 25% coverage of the JD's key technical terms, targeting 40%+ for strong matches. Place the highest-priority keywords in: summary first sentence, skills section, and first bullet of each employment entry. Include both long-form and abbreviations where applicable (e.g., "Continuous Integration / CI/CD").

3. IMPACT BULLETS: Every bullet must use "action verb + specific achievement + quantified result". Include real project names, real technologies, and real metrics from the candidate's profile. Never genericize specific accomplishments into vague descriptions.
   Bad: "Optimized front-end performance"
   Good: "Reduced page load time by 40% through code splitting and lazy loading across 25+ React components" (use the candidate's actual project name, technology, and metric)

4. AUTHENTICITY: Vary sentence structure and verb choices across bullets. Never use: "results-driven", "proven track record", "leveraging", "dynamic team player", "synergies", "spearheaded". Every bullet must contain at least one detail specific to THIS candidate's actual experience — a project name, a technology choice, a metric, or a specific outcome.

5. PER-ROLE BULLET PRIORITIZATION: For each employment entry, lead with bullets that demonstrate skills matching the JD's core requirements. The first bullet of the most recent role MUST directly address the JD's primary responsibility. Deprioritize or omit bullets about skills the JD doesn't mention.

6. EXPERIENCE SECTION — the "bullets" array on each employment entry is your pool. Select from it and lightly adapt — do not invent new bullets. Follow this pattern:

  Profile entry:
  {
    "company": "Acme Corp",
    "title": "Senior Engineer",
    "start_date": "2024-03",
    "end_date": null,
    "bullets": [
      "Led end-to-end delivery across the full product lifecycle, from specification through production",
      "Automated deployment pipeline, reducing release cycle from days to minutes",
      "Integrated LLM-based features into production, cutting manual review time by 60%"
    ]
  }

  Output for a DevOps-focused JD:
  {
    "company": "Acme Corp",
    "title": "Senior Engineer",
    "start_date": "2024-03",
    "end_date": null,
    "bullets": [
      "Automated CI/CD pipeline, reducing release cycle from days to minutes",
      "Led end-to-end delivery across the full product lifecycle, from specification through production"
    ]
  }

  Output for an AI/ML-focused JD:
  {
    "company": "Acme Corp",
    "title": "Senior Engineer",
    "start_date": "2024-03",
    "end_date": null,
    "bullets": [
      "Integrated LLM-based features into production, cutting manual review time by 60%",
      "Led end-to-end delivery across the full product lifecycle, from specification through production"
    ]
  }

7. SKILLS ORDERING: List 10-15 skills ordered by relevance to the target role. Skills mentioned in the JD come first. Include both the JD's exact terminology and the candidate's equivalent terms.

8. SELF-EMPLOYMENT FRAMING: For self-employed or solo entrepreneur roles, frame the work as if it were a job matching the JD title. Describe the JD-relevant work performed — not just the technical architecture. If the JD emphasizes design, describe design work; if it emphasizes backend, describe backend work. Technical architecture details belong in the Projects section, not Employment bullets.

9. PROJECTS SECTION: Projects should highlight what makes the work impressive at a glance — key features, scale, and standout achievements. Keep it concise with a brief description and 3-4 bullet highlights. Technical architecture depth is welcome here. This is the "nice-to-have" that demonstrates breadth and initiative.

Additional rules:
- Never fabricate credentials, titles, dates, or skills
- Do NOT include a "contact" key in your JSON — it will be injected server-side
- Each project in the profile represents a distinct goal and outcome — never merge or combine them regardless of shared tech stack. Treat each as its own entry. As the portfolio grows, include only the projects most relevant to the target JD.

Respond with structured JSON:
{
  "summary": "...",
  "skills": [...],
  "employment": [...],
  "education": [...],
  "projects": [{ "slug": "<from profile, verbatim>", "name": "...", "highlights": [...], ... }]
}`

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
      const relevantThoughts = await queryRelevantThoughts(job_description)

      const visibleProfile = {
        ...profile,
        projects: filterVisibleProjects(profile.projects, HIDE_FROM_PROJECTS),
      }

      let userMessage = `Candidate profile:\n${JSON.stringify(visibleProfile, null, 2)}`

      if (relevantThoughts.length) {
        userMessage += `\n\nAdditional context from candidate's shipped work (each entry is attributed — use the project and date to place it correctly in the resume):\n${relevantThoughts.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
      }

      userMessage += `\n\nTarget job description:\n${job_description}`

      if (framing_hints?.length) {
        userMessage += `\n\nFraming guidance:\n${framing_hints.map((h) => `- ${h.replace(/\n+/g, ' ')}`).join('\n')}`
      }

      async function generateOne(modelId: string): Promise<ResumeResponse | null> {
        try {
          const { text: raw } = await generateText({
            model: getModel(modelId),
            maxTokens: 8192,
            system: systemPrompt,
            prompt: userMessage,
          })
          return parseJSON<ResumeResponse>(raw)
        } catch (err) {
          console.error(`[resume] Generation failed for model ${modelId}:`, err instanceof Error ? err.message : err)
          return null
        }
      }

      const [gen1, gen2] = await Promise.all([generateOne(RESUME_MODEL), generateOne(RESUME_MODEL_B)])

      type Candidate = { resume: ResumeResponse; rubric: RubricResult; model: string }
      const candidates: Candidate[] = []

      // Strip banned phrases before scoring so Rule 4 reflects the final output quality,
      // not the raw generation — ensures the winner is the best post-processed resume.
      if (gen1) { const r = stripBannedPhrases(gen1); candidates.push({ resume: r, rubric: scoreResume(r, job_description), model: RESUME_MODEL }) }
      if (gen2) { const r = stripBannedPhrases(gen2); candidates.push({ resume: r, rubric: scoreResume(r, job_description), model: RESUME_MODEL_B }) }

      if (candidates.length === 0) {
        send(`data: ${JSON.stringify({ error: 'Both resume generations failed to parse' })}\n\n`)
        return
      }

      candidates.sort((a, b) => b.rubric.total - a.rubric.total)
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
            metadata: { type: 'observation', topics: ['resume-failure', 'rubric'] },
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
