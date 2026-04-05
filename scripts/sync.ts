/**
 * GitHub-to-OB1 project sync
 *
 * 1. Fetches README.md from configured GitHub repos via the GitHub Contents API
 * 2. Updates each project's architecture field in public_profile
 * 3. Rebuilds the CANDIDATE_STACK thought from the current profile —
 *    framing.ts in job-hunt-agent reads this at runtime instead of a hardcoded constant
 *
 * Usage:   npm run sync
 * Env:     GITHUB_TOKEN  optional but recommended (higher rate limit)
 *          SUPA_PROJECT_URL, SUPA_SERVICE_ROLE  required
 */

import { createClient } from '@supabase/supabase-js'
import { createOpenAI } from '@ai-sdk/openai'
import { embed } from 'ai'

// Load env manually so the script works with --env-file flag
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

const PROFILE_ID = '00000000-0000-0000-0000-000000000001'

// Repos to sync — slug must match the project slug in public_profile.projects
const REPOS = [
  { slug: 'artisan-roast', owner: 'yuens1002', repo: 'artisan-roast-platform' },
  { slug: 'resume-agent',  owner: 'yuens1002', repo: 'resume-agent' },
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

interface ProfileRow {
  projects: Array<{ slug: string; status?: string; name?: unknown; tech?: unknown; highlights?: unknown; [key: string]: unknown }>
  skills: Array<{ category: string; items: string[] }>
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

// ── Project sync ──────────────────────────────────────────

function syncProject(
  slug: string,
  readme: string,
  projects: ProfileRow['projects'],
): ProfileRow['projects'] {
  const idx = projects.findIndex(p => p.slug === slug)
  if (idx < 0) {
    console.log(`  ⚠ "${slug}" not found in profile — skipping`)
    return projects
  }
  // Store the first 3000 chars of README as the architecture summary
  const architecture = readme.slice(0, 3000)
  projects[idx] = { ...projects[idx], architecture }
  return projects
}

// ── CANDIDATE_STACK ───────────────────────────────────────

function buildCandidateStack(profile: ProfileRow): string {
  const skillLines = profile.skills.map(s => s.items.join(', '))
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

  // Insert new thought first — if this fails, the old one is still intact
  const { error: insertError } = await supabase.from('thoughts').insert({
    content,
    embedding,
    metadata: { type: 'reference', topics: ['candidate_stack'], source: 'sync' },
  })
  if (insertError) throw new Error(`Failed to insert CANDIDATE_STACK thought: ${insertError.message}`)

  // Only delete stale entries after the new one is safely written
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
    const readme = await fetchGitHubFile(r.owner, r.repo, 'README.md')
    if (readme) {
      projects = syncProject(r.slug, readme, projects)
      console.log(`  ✔ architecture updated (${readme.length} chars → capped at 3000)`)
    } else {
      console.log(`  ⚠ README.md not found — skipping architecture update`)
    }
  }

  await saveProjects(projects)
  console.log('Projects saved.\n')

  console.log('Rebuilding CANDIDATE_STACK...')
  const stack = buildCandidateStack(profile)
  await upsertCandidateStack(stack)
  console.log('  ✔ CANDIDATE_STACK thought updated')
  console.log('\nSync complete.')
}

sync().catch(err => {
  console.error('Sync failed:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
