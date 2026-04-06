/**
 * GitHub-to-OB1 project sync
 *
 * Per repo:
 * 1. Fetches architecture doc (README.md by default; overridden via docsPath)
 * 2. Fetches CHANGELOG.md
 * 3. Reconciles architecture field — LLM compares current value against docs,
 *    rewrites only if something material changed
 * 4. Reconciles highlights array — LLM scans full changelog for greatest-hit
 *    engineering achievements, enriches without replacing what's already there
 * 5. Writes both fields back via upsert_project
 *
 * Also rebuilds the CANDIDATE_STACK thought from the updated profile.
 *
 * Usage:   npm run sync
 * Env:     GITHUB_TOKEN         optional but recommended (higher rate limit)
 *          SUPA_PROJECT_URL     required
 *          SUPA_SERVICE_ROLE    required
 *          OPENROUTER_API_KEY   required
 */

import { createClient } from '@supabase/supabase-js'
import { createOpenAI } from '@ai-sdk/openai'
import { embed, generateText } from 'ai'

const SUPA_URL = process.env.SUPA_PROJECT_URL
const SUPA_KEY = process.env.SUPA_SERVICE_ROLE
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const GITHUB_TOKEN = process.env.GITHUB_TOKEN

if (!SUPA_URL || !SUPA_KEY) {
  console.error('Missing SUPA_PROJECT_URL or SUPA_SERVICE_ROLE')
  process.exit(1)
}
if (!OPENROUTER_API_KEY) {
  console.error('Missing OPENROUTER_API_KEY')
  process.exit(1)
}

const supabase = createClient(SUPA_URL, SUPA_KEY)
const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: OPENROUTER_API_KEY,
})

const MODEL = 'anthropic/claude-haiku-4.5'
const PROFILE_ID = '00000000-0000-0000-0000-000000000001'

// Repos to sync — slug must match the project slug in public_profile.projects
// docsPath overrides README.md when the root README is just boilerplate
const REPOS = [
  { slug: 'artisan-roast',          owner: 'yuens1002',       repo: 'artisan-roast' },
  { slug: 'artisan-roast-platform', owner: 'dev-yuen-agency', repo: 'artisan-roast-platform', docsPath: 'docs/platform/platform.md' },
  { slug: 'resume-agent',           owner: 'yuens1002',       repo: 'resume-agent' },
]

// ── GitHub ────────────────────────────────────────────────

async function fetchGitHubFile(owner: string, repo: string, path: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`

  const res = await fetch(url, { headers })
  if (!res.ok) {
    if (res.status !== 404) console.warn(`  GitHub ${res.status} for ${owner}/${repo}/${path}`)
    return null
  }

  const data = await res.json() as { content?: string }
  if (!data.content) return null
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
}

// ── Profile helpers ───────────────────────────────────────

interface ProjectEntry {
  slug: string
  name?: unknown
  status?: string
  tech?: unknown
  highlights?: unknown
  architecture?: string
  [key: string]: unknown
}

interface ProfileRow {
  projects: ProjectEntry[]
  skills?: Array<{ category?: string; items?: string[] | null }> | null
}

async function loadProfile(): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from('public_profile')
    .select('projects, skills')
    .eq('id', PROFILE_ID)
    .single()
  if (error || !data) {
    console.error('Failed to load profile:', error?.message)
    return null
  }
  return data as ProfileRow
}

async function saveProjects(projects: ProfileRow['projects']): Promise<void> {
  const { error } = await supabase
    .from('public_profile')
    .update({ projects, updated_at: new Date().toISOString() })
    .eq('id', PROFILE_ID)
  if (error) throw new Error(`Failed to save projects: ${error.message}`)
}

// ── Markdown stripping ────────────────────────────────────

function stripMarkdown(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[!\[.*?\]\(.*?\)\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/^\|.*\|$/gm, '')
    .replace(/^[-| :]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Architecture reconciliation ───────────────────────────

function looksLikeRawMarkdown(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  return /(^|\n)\s*#{1,6}\s+|(^|\n)\s*\|.*\||\[!\[|!\[.*\]\(|```/.test(normalized)
}

async function reconcileArchitecture(
  projectName: string,
  currentArchitecture: string,
  archDoc: string,
): Promise<{ updated: boolean; value: string }> {
  const doc = stripMarkdown(archDoc).slice(0, 6000)

  // Force rewrite if current value is raw markdown, not a clean prose summary
  const forceRewrite = !currentArchitecture || looksLikeRawMarkdown(currentArchitecture)

  const { text } = await generateText({
    model: openrouter(MODEL),
    prompt: `You are maintaining the "architecture" field of a developer portfolio API.

Current value:
${currentArchitecture || '(empty)'}

Latest documentation:
${doc}

${forceRewrite
  ? 'The current value is raw or empty — write a fresh summary.'
  : 'If the current value is already an accurate plain-prose summary, respond with exactly: NO_CHANGE'
}

Write a 3–5 sentence plain-prose summary covering:
1. What the project does
2. Key technical stack and components
3. Notable engineering decisions or patterns

No markdown, no bullet points. Audience: hiring engineers and AI agents.
Project: ${projectName}`,
    maxTokens: 350,
  })

  const result = text.trim()
  if (result === 'NO_CHANGE') {
    if (!forceRewrite) return { updated: false, value: currentArchitecture }
    // Model ignored the force-rewrite instruction — fall back to stripped doc
    return { updated: true, value: stripMarkdown(doc) }
  }
  return { updated: true, value: stripMarkdown(result) }
}

// ── Highlights reconciliation ─────────────────────────────

async function reconcileHighlights(
  projectName: string,
  currentHighlights: string[],
  changelog: string,
): Promise<{ updated: boolean; value: string[] }> {
  const log = stripMarkdown(changelog).slice(0, 8000)

  const { text } = await generateText({
    model: openrouter(MODEL),
    prompt: `You are maintaining the "highlights" array of a developer portfolio API.
This is a curated list of the greatest engineering achievements on the project — the kind of things that demonstrate technical depth to a hiring engineer.

Current highlights:
${currentHighlights.length ? currentHighlights.map((h, i) => `${i + 1}. ${h}`).join('\n') : '(empty)'}

Full changelog:
${log}

Rules:
- Scan the changelog for significant engineering achievements not already captured in the current highlights
- Add new entries for anything impressive: novel systems built, hard problems solved, meaningful scale or automation
- Remove or update any existing entries that are now outdated or superseded
- Keep entries specific and technical (mention the thing built, not just that something was "added")
- Aim for 5–8 total highlights, ordered from most to least impressive
- If current highlights already capture everything well, respond with exactly: NO_CHANGE

If changes are needed, respond with a JSON array of strings only — no prose, no markdown.
Project: ${projectName}`,
    maxTokens: 600,
  })

  const result = text.trim()
  if (result === 'NO_CHANGE') return { updated: false, value: currentHighlights }

  try {
    const cleaned = result.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim()
    const parsed = JSON.parse(cleaned) as string[]
    return { updated: true, value: parsed }
  } catch {
    console.warn('  ⚠ Could not parse highlights JSON — keeping current')
    return { updated: false, value: currentHighlights }
  }
}

// ── Project sync ──────────────────────────────────────────

async function syncProject(
  r: typeof REPOS[number],
  projects: ProfileRow['projects'],
): Promise<ProfileRow['projects']> {
  const idx = projects.findIndex(p => p.slug === r.slug)
  if (idx < 0) {
    console.log(`  ⚠ "${r.slug}" not found in profile — skipping`)
    return projects
  }

  const project = projects[idx]
  const projectName = String(project.name ?? r.slug)
  const currentArchitecture = project.architecture ?? ''
  const currentHighlights = Array.isArray(project.highlights)
    ? (project.highlights as string[])
    : []

  // Fetch both docs in parallel
  const archPath = r.docsPath ?? 'README.md'
  const [archDoc, changelog] = await Promise.all([
    fetchGitHubFile(r.owner, r.repo, archPath),
    fetchGitHubFile(r.owner, r.repo, 'CHANGELOG.md'),
  ])

  let updated = false

  if (archDoc) {
    const arch = await reconcileArchitecture(projectName, currentArchitecture, archDoc)
    if (arch.updated) {
      project.architecture = arch.value
      updated = true
      console.log(`  ✔ architecture updated`)
    } else {
      console.log(`  — architecture unchanged`)
    }
  } else {
    console.log(`  ⚠ ${archPath} not found — skipping architecture`)
  }

  if (changelog) {
    const hi = await reconcileHighlights(projectName, currentHighlights, changelog)
    if (hi.updated) {
      project.highlights = hi.value
      updated = true
      console.log(`  ✔ highlights updated (${hi.value.length} entries)`)
    } else {
      console.log(`  — highlights unchanged`)
    }
  } else {
    console.log(`  ⚠ CHANGELOG.md not found — skipping highlights`)
  }

  if (updated) projects[idx] = { ...project }
  return projects
}

// ── CANDIDATE_STACK ───────────────────────────────────────

function buildCandidateStack(profile: ProfileRow): string {
  const skillLines = (profile.skills ?? [])
    .map(s => Array.isArray(s.items) ? s.items.join(', ') : '')
    .filter(Boolean)
  const projectLines = profile.projects
    .filter(p => p.status === 'active' || p.status === 'in-progress')
    .map(p => {
      const tech = Array.isArray(p.tech) ? (p.tech as string[]).join(', ') : ''
      const highlight = Array.isArray(p.highlights) ? (p.highlights as string[])[0] : ''
      return tech ? `${p.name} (${tech})${highlight ? ': ' + highlight : ''}` : String(p.name)
    })
  return [...skillLines, ...projectLines].filter(Boolean).join('; ')
}

async function upsertCandidateStack(stack: string): Promise<void> {
  const content = `CANDIDATE_STACK: ${stack}`

  const { embedding } = await embed({
    model: openrouter.embedding('openai/text-embedding-3-small'),
    value: content,
  })

  const { error: insertError } = await supabase.from('thoughts').insert({
    content,
    embedding,
    metadata: { type: 'reference', topics: ['candidate_stack'], source: 'sync' },
  })
  if (insertError) throw new Error(`Failed to insert CANDIDATE_STACK thought: ${insertError.message}`)

  const { error: deleteError } = await supabase
    .from('thoughts')
    .delete()
    .contains('metadata', { topics: ['candidate_stack'] })
    .neq('content', content)
  if (deleteError) throw new Error(`Failed to delete stale CANDIDATE_STACK thoughts: ${deleteError.message}`)
}

// ── Main ──────────────────────────────────────────────────

async function sync(): Promise<void> {
  const profile = await loadProfile()
  if (!profile) { process.exitCode = 1; return }

  let projects = profile.projects

  for (const r of REPOS) {
    console.log(`Syncing ${r.slug}...`)
    projects = await syncProject(r, projects)
  }

  await saveProjects(projects)
  console.log('\nProjects saved.')

  console.log('\nRebuilding CANDIDATE_STACK...')
  const stack = buildCandidateStack({ ...profile, projects })
  await upsertCandidateStack(stack)
  console.log('  ✔ CANDIDATE_STACK thought updated')
  console.log('\nSync complete.')
}

sync().catch(err => {
  console.error('Sync failed:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
