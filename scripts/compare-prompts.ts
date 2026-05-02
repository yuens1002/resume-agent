/**
 * compare-prompts.ts
 *
 * Runs the old and new resume generation system prompts in parallel against
 * the same profile + JD, then prints the employment sections side-by-side
 * so you can see the delta before committing.
 *
 * Usage:
 *   npm run compare:prompts
 *   npm run compare:prompts -- "paste a JD here as a single arg"
 */

import { generateText } from 'ai'
import { supabase } from '../src/lib/supabase.js'
import { getModel } from '../src/lib/ai.js'
import { parseJSON } from '../src/lib/parse-json.js'
import type { ResumeResponse, Employment } from '../src/types.js'

const MODEL_A = process.env.RESUME_MODEL ?? 'openai/gpt-4o-mini'
const MODEL_B = process.env.RESUME_MODEL_B ?? MODEL_A
// 'prompt' = old vs new with MODEL_A | 'model' = MODEL_A vs MODEL_B with new prompt
const MODE = process.argv.includes('--model') ? 'model' : 'prompt'

const SAMPLE_JD = `
Senior AI Product Engineer

We're looking for a product-minded engineer to lead development of AI-powered features
in our SaaS platform. You'll own the full cycle — from spec through production — and
work closely with LLMs, build reliable agentic workflows, and keep quality high as we scale.

Requirements:
- 4+ years building production software end-to-end
- Experience integrating LLMs / AI APIs into real products
- Strong TypeScript and backend fundamentals
- Familiarity with CI/CD, observability, and multi-tenant architecture
- Ability to work autonomously across design, implementation, and operations
`.trim()

// ── Old prompt (pre-fix) ─────────────────────────────────────────────────────

const OLD_SYSTEM_PROMPT = `You are a professional resume writer optimizing for ATS (Applicant Tracking Systems) and human recruiter review. Generate a tailored resume for the candidate based on their profile and the target job description.

Rules:

1. SUMMARY — JD TITLE FIRST: Your opening words in the summary MUST use the exact job title from the job description, not the candidate's default self-description. Follow with years of experience and 3-5 high-priority skills from the JD woven naturally.
   Example: If JD says "Sr UX Engineer", open with "Senior UX Engineer with 6+ years..." — never "Full-stack engineer".

2. KEYWORD COVERAGE: Achieve at least 25% coverage of the JD's key technical terms, targeting 40%+ for strong matches. Place the highest-priority keywords in: summary first sentence, skills section, and first bullet of each employment entry. Include both long-form and abbreviations where applicable (e.g., "Continuous Integration / CI/CD").

3. IMPACT BULLETS: Every bullet must use "action verb + specific achievement + quantified result". Include real project names, real technologies, and real metrics from the candidate's profile. Never genericize specific accomplishments into vague descriptions.
   Bad: "Optimized front-end performance"
   Good: "Reduced page load time by 40% through code splitting and lazy loading across 25+ React components" (use the candidate's actual project name, technology, and metric)

4. AUTHENTICITY: Vary sentence structure and verb choices across bullets. Never use: "results-driven", "proven track record", "leveraging", "dynamic team player", "synergies", "spearheaded". Every bullet must contain at least one detail specific to THIS candidate's actual experience — a project name, a technology choice, a metric, or a specific outcome.

5. PER-ROLE BULLET PRIORITIZATION: For each employment entry, lead with bullets that demonstrate skills matching the JD's core requirements. The first bullet of the most recent role MUST directly address the JD's primary responsibility. Deprioritize or omit bullets about skills the JD doesn't mention.

6. SKILLS ORDERING: List 10-15 skills ordered by relevance to the target role. Skills mentioned in the JD come first. Include both the JD's exact terminology and the candidate's equivalent terms.

7. SELF-EMPLOYMENT FRAMING: For self-employed or solo entrepreneur roles, frame the work as if it were a job matching the JD title. Describe the JD-relevant work performed — not just the technical architecture. If the JD emphasizes design, describe design work; if it emphasizes backend, describe backend work. Technical architecture details belong in the Projects section, not Employment bullets.

8. PROJECTS SECTION: Projects should highlight what makes the work impressive at a glance — key features, scale, and standout achievements. Keep it concise with a brief description and 3-4 bullet highlights. Technical architecture depth is welcome here. This is the "nice-to-have" that demonstrates breadth and initiative.

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
  "projects": [...]
}`

// ── New prompt (with Rule 6 pattern) ─────────────────────────────────────────

const NEW_SYSTEM_PROMPT = `You are a professional resume writer optimizing for ATS (Applicant Tracking Systems) and human recruiter review. Generate a tailored resume for the candidate based on their profile and the target job description.

Rules:

1. SUMMARY — JD TITLE FIRST: Your opening words in the summary MUST use the exact job title from the job description, not the candidate's default self-description. Follow with years of experience and 3-5 high-priority skills from the JD woven naturally.
   Example: If JD says "Sr UX Engineer", open with "Senior UX Engineer with 6+ years..." — never "Full-stack engineer".

2. KEYWORD COVERAGE: Achieve at least 25% coverage of the JD's key technical terms, targeting 40%+ for strong matches. Place the highest-priority keywords in: summary first sentence, skills section, and first bullet of each employment entry. Include both long-form and abbreviations where applicable (e.g., "Continuous Integration / CI/CD").

3. IMPACT BULLETS: Every bullet must use "action verb + specific achievement + quantified result". Include real project names, real technologies, and real metrics from the candidate's profile. Never genericize specific accomplishments into vague descriptions.
   Bad: "Optimized front-end performance"
   Good: "Reduced page load time by 40% through code splitting and lazy loading across 25+ React components" (use the candidate's actual project name, technology, and metric)

4. AUTHENTICITY: Vary sentence structure and verb choices across bullets. Never use: "results-driven", "proven track record", "leveraging", "dynamic team player", "synergies", "spearheaded". Every bullet must contain at least one detail specific to THIS candidate's actual experience — a project name, a technology choice, a metric, or a specific outcome.

5. PER-ROLE BULLET PRIORITIZATION: For each employment entry, lead with bullets that demonstrate skills matching the JD's core requirements. The first bullet of the most recent role MUST directly address the JD's primary responsibility. Deprioritize or omit bullets about skills the JD doesn't mention.

6. EXPERIENCE SECTION — the \`bullets\` array on each employment entry is your pool. Select from it and lightly adapt — do not invent new bullets. Follow this pattern:

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
  "projects": [...]
}`

// ── Helpers ──────────────────────────────────────────────────────────────────

function printEmployment(label: string, result: ResumeResponse) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${label}`)
  console.log('─'.repeat(60))
  if (!Array.isArray(result.employment)) {
    console.log(`  [no employment array — raw output: ${JSON.stringify(result).slice(0, 200)}]`)
    return
  }
  for (const e of result.employment) {
    console.log(`\n  ${e.company} — ${e.title}`)
    console.log(`  ${e.start_date} → ${e.end_date ?? 'present'}`)
    const bullets = Array.isArray(e.bullets) ? e.bullets : []
    for (const b of bullets) {
      console.log(`    • ${b}`)
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const jd = process.argv.find((a, i) => i >= 2 && !a.startsWith('--') && !a.endsWith('.ts') && !a.endsWith('.js')) ?? SAMPLE_JD

const { data: profile, error } = await supabase
  .from('public_profile')
  .select('*')
  .eq('id', '00000000-0000-0000-0000-000000000001')
  .single()

if (error || !profile) {
  console.error('Profile not found:', error?.message)
  process.exit(1)
}

const userMessage = `Candidate profile:\n${JSON.stringify(profile, null, 2)}\n\nTarget job description:\n${jd}`

console.log(`\nMode: ${MODE}`)
console.log(`Model A: ${MODEL_A}`)
if (MODE === 'model') console.log(`Model B: ${MODEL_B}`)
console.log(`JD preview: ${jd.slice(0, 80).replace(/\n/g, ' ')}…`)
console.log(`\nRunning in parallel…`)

async function generate(systemPrompt: string, modelId: string): Promise<ResumeResponse | null> {
  try {
    const { text } = await generateText({
      model: getModel(modelId),
      maxTokens: 8192,
      system: systemPrompt,
      prompt: userMessage,
    })
    return parseJSON<ResumeResponse>(text)
  } catch (err) {
    console.error(`Generation failed (${modelId}):`, err instanceof Error ? err.message : err)
    return null
  }
}

if (MODE === 'model') {
  const [resultA, resultB] = await Promise.all([
    generate(NEW_SYSTEM_PROMPT, MODEL_A),
    generate(NEW_SYSTEM_PROMPT, MODEL_B),
  ])
  if (!resultA) { console.error(`${MODEL_A} generation failed`); process.exit(1) }
  if (!resultB) { console.error(`${MODEL_B} generation failed`); process.exit(1) }
  printEmployment(MODEL_A, resultA)
  printEmployment(MODEL_B, resultB)
} else {
  const [oldResult, newResult] = await Promise.all([
    generate(OLD_SYSTEM_PROMPT, MODEL_A),
    generate(NEW_SYSTEM_PROMPT, MODEL_A),
  ])
  if (!oldResult) { console.error('OLD prompt generation failed'); process.exit(1) }
  if (!newResult) { console.error('NEW prompt generation failed'); process.exit(1) }
  printEmployment('OLD PROMPT', oldResult)
  printEmployment('NEW PROMPT', newResult)
}

console.log('\n')
