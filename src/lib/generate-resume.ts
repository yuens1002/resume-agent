/**
 * Résumé generation core (#298 D7): builds the prompt, runs two independent
 * generations, post-processes and scores each, and picks the winner.
 *
 * Shared by the `/resume` route and `npm run eval:resume`, so the eval runs
 * exactly what production serves. Side effects that belong to the route —
 * SSE framing, rubric-failure telemetry, contact and URL injection — stay in
 * the route.
 */

import { generateText } from 'ai'
import { getModel } from './ai.js'
import { parseJSON } from './parse-json.js'
import { scoreResume, type RubricResult } from './score-resume.js'
import { stripBannedPhrases } from './strip-banned.js'
import { dropUngroundedNumbers, groundedNumbers, normalizeResumeFormat, RESUME_BUDGET as B } from './resume-format.js'
import { queryRelevantThoughts } from './thoughts-query.js'
import { parseHiddenProjectSlugs, filterVisibleProjects } from './hidden-projects.js'
import type { ResumeResponse } from '../types.js'

export const RESUME_MODEL = process.env.RESUME_MODEL ?? 'openai/gpt-4o-mini'
export const RESUME_MODEL_B = process.env.RESUME_MODEL_B ?? RESUME_MODEL
const HIDE_FROM_PROJECTS = parseHiddenProjectSlugs(process.env.HIDE_FROM_PROJECTS)

export const RESUME_SYSTEM_PROMPT = `You are a professional resume writer optimizing for ATS (Applicant Tracking Systems) and human recruiter review. Generate a tailored resume for the candidate based on their profile and the target job description.

Rules:

1. SUMMARY — JD TITLE FIRST: Your opening words in the summary MUST use the exact job title from the job description, not the candidate's default self-description. Follow with years of experience and 3-5 high-priority skills from the JD woven naturally.
   Example: If JD says "Sr UX Engineer", open with "Senior UX Engineer with 6+ years..." — never "Full-stack engineer".
   Keep the summary to at most ${B.summarySentences} sentences. No abstract descriptors ("deterministic, auditable, and maintainable") — name concrete stack and focus instead.

2. KEYWORD COVERAGE: Achieve at least 25% coverage of the JD's key technical terms, targeting 40%+ for strong matches. Place the highest-priority keywords in: summary first sentence, skills section, and first bullet of each employment entry. Include both long-form and abbreviations where applicable (e.g., "Continuous Integration / CI/CD").

3. IMPACT BULLETS (STAR/XYZ): Every bullet follows "accomplished [X], as measured by [Y], by doing [Z]": a past-tense action verb, a specific result, and how it was done. The result is a real metric from the profile when one exists; otherwise a concrete, checkable outcome. NEVER invent or estimate a number.
   Bullet grammar: start with a past-tense verb (never "functions as", never a verbless phrase), no trailing period, no "&", and no slashes between alternatives ("React and Redux", not "React/Redux"; established names like CI/CD are fine). Include real project names, real technologies, and real metrics from the candidate's profile. Never genericize specific accomplishments into vague descriptions.
   Bad: "Optimized front-end performance"
   Good: "Reduced page load time by 40% through code splitting and lazy loading across 25+ React components" (use the candidate's actual project name, technology, and metric)

4. AUTHENTICITY: Vary sentence structure and verb choices across bullets. Never use: "results-driven", "proven track record", "leveraging", "dynamic team player", "synergies", "spearheaded", "utilized", "participated in", "enhanced", "functions as", "responsible for". Every bullet must contain at least one detail specific to THIS candidate's actual experience — a project name, a technology choice, a metric, or a specific outcome.

5. PER-ROLE BULLET PRIORITIZATION: For each employment entry, lead with bullets that demonstrate skills matching the JD's core requirements. The first bullet of the most recent role MUST directly address the JD's primary responsibility. Deprioritize or omit bullets about skills the JD doesn't mention.

6. EXPERIENCE SECTION — the "bullets" array on each employment entry is your pool. Select from it and lightly adapt — do not invent new bullets. Lightly adapting includes replacing a weak opening verb ("utilized", "participated in", "enhanced") with a precise past-tense one and applying the bullet grammar in Rule 3; it never includes adding a metric. The most recent role keeps at most ${B.mostRecentRoleBullets} bullets, every earlier role at most ${B.otherRoleBullets} — pick the ones most relevant to the JD. Follow this pattern:

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

7. SKILLS: Group skills into at most ${B.skillRows} labelled rows (e.g. "Languages", "Frameworks and Runtimes", "Databases and Tools", "Testing and CI"), each { "category": "...", "items": [...] }. List concrete, named tools only — no concepts such as "AI Agents", "Automation and Workflows" or "API Integrations"; demonstrate those in bullets instead. Order rows and items by relevance to the JD; skills the JD names come first, using the JD's exact terminology.

8. SELF-EMPLOYMENT FRAMING: For self-employed or solo entrepreneur roles, frame the work as if it were a job matching the JD title. Describe the JD-relevant work performed — not just the technical architecture. If the JD emphasizes design, describe design work; if it emphasizes backend, describe backend work. Technical architecture details belong in the Projects section, not Employment bullets. Never restate a product you list under Projects in the self-employment bullets — describe role, delivery scope and outcomes there instead.

9. PROJECTS SECTION: Projects should highlight what makes the work impressive at a glance — key features, scale, and standout achievements. Include only the 1–${B.projects} projects most relevant to the JD, each with a brief description and at most ${B.projectHighlights} highlights. Technical architecture depth is welcome here. This is the "nice-to-have" that demonstrates breadth and initiative.

Additional rules:
- Roles under "pinned_employment" are owner-written and are added to the resume automatically, exactly as written. Do NOT include them in your "employment" array; use them only as context (e.g. for the summary).
- Never fabricate credentials, titles, dates, or skills
- Do NOT include a "contact" key in your JSON — it will be injected server-side
- Each project in the profile represents a distinct goal and outcome — never merge or combine them regardless of shared tech stack. Treat each as its own entry. As the portfolio grows, include only the projects most relevant to the target JD.

Respond with structured JSON:
{
  "summary": "...",
  "skills": [{ "category": "...", "items": ["..."] }],
  "employment": [...],
  "education": [...],
  "projects": [{ "slug": "<from profile, verbatim>", "name": "...", "highlights": [...], ... }]
}`

export interface ResumeCandidate {
  resume: ResumeResponse
  rubric: RubricResult
  model: string
}

export interface GenerateResumeInput {
  profile: Record<string, any>
  jobDescription: string
  framingHints?: string[]
}

export function buildResumeUserMessage(
  visibleProfile: Record<string, any>,
  relevantThoughts: string[],
  jobDescription: string,
  framingHints?: string[],
): string {
  let userMessage = `Candidate profile:\n${JSON.stringify(visibleProfile, null, 2)}`
  if (relevantThoughts.length) {
    userMessage += `\n\nAdditional context from candidate's shipped work (each entry is attributed — use the project and date to place it correctly in the resume):\n${relevantThoughts.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
  }
  userMessage += `\n\nTarget job description:\n${jobDescription}`
  if (framingHints?.length) {
    userMessage += `\n\nFraming guidance:\n${framingHints.map((h) => `- ${h.replace(/\n+/g, ' ')}`).join('\n')}`
  }
  return userMessage
}

export interface GenerateResumeResult {
  /** Sorted best-first by rubric total; empty when both generations failed. */
  candidates: ResumeCandidate[]
  /** The exact Open Brain thoughts the model was given, for grounding checks. */
  relevantThoughts: string[]
}

/**
 * Each candidate is already post-processed, so its score reflects what ships:
 * banned phrases stripped, the format and content budget applied (pinned
 * roles inserted from the profile), then any generator-written bullet citing
 * a number not grounded in the profile's text or the given thoughts dropped.
 */
export async function generateResume({ profile, jobDescription, framingHints }: GenerateResumeInput): Promise<GenerateResumeResult> {
  const relevantThoughts = await queryRelevantThoughts(jobDescription)
  // Pinned roles are inserted from the profile after generation (#298 D9), so
  // the model sees them only as context, never as part of its employment pool.
  const employment: Array<{ pinned?: unknown }> = Array.isArray(profile.employment) ? profile.employment : []
  const visibleProfile = {
    ...profile,
    employment: employment.filter((e) => e?.pinned !== true),
    pinned_employment: employment.filter((e) => e?.pinned === true),
    projects: filterVisibleProjects(profile.projects, HIDE_FROM_PROJECTS),
  }
  const userMessage = buildResumeUserMessage(visibleProfile, relevantThoughts, jobDescription, framingHints)

  async function generateOne(modelId: string): Promise<ResumeResponse | null> {
    try {
      const { text: raw } = await generateText({
        model: getModel(modelId),
        // Reasoning models spend output tokens thinking before they answer; at
        // 8,192 one model used the whole budget reasoning and returned nothing,
        // and another was truncated mid-JSON. The cap covers reasoning + answer.
        maxTokens: 16000,
        system: RESUME_SYSTEM_PROMPT,
        prompt: userMessage,
      })
      return parseJSON<ResumeResponse>(raw)
    } catch (err) {
      console.error(`[resume] Generation failed for model ${modelId}:`, err instanceof Error ? err.message : err)
      return null
    }
  }

  const [gen1, gen2] = await Promise.all([generateOne(RESUME_MODEL), generateOne(RESUME_MODEL_B)])

  const grounded = groundedNumbers(profile, relevantThoughts)
  const candidates: ResumeCandidate[] = []
  for (const [gen, model] of [[gen1, RESUME_MODEL], [gen2, RESUME_MODEL_B]] as const) {
    if (!gen) continue
    // A malformed shape from one model (e.g. `projects: [null]`) drops that
    // candidate only, instead of failing the whole request.
    try {
      const formatted = normalizeResumeFormat(stripBannedPhrases(gen), profile.employment)
      const { resume: r, dropped } = dropUngroundedNumbers(formatted, grounded)
      if (dropped.length) console.warn(`[resume] Dropped ${dropped.length} bullet(s) citing ungrounded numbers from model ${model}`)
      candidates.push({ resume: r, rubric: scoreResume(r, jobDescription), model })
    } catch (err) {
      console.error(`[resume] Post-processing failed for model ${model}:`, err instanceof Error ? err.message : err)
    }
  }
  return { candidates: candidates.sort((a, b) => b.rubric.total - a.rubric.total), relevantThoughts }
}
