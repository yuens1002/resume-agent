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
 * Repos to sync are derived from profile.projects — any project with a GitHub
 * repo URL is synced automatically. No env var needed; add a project to the
 * profile and the next sync picks it up.
 *
 * Usage:   npm run sync
 * Env:     GITHUB_TOKEN         optional but recommended (higher rate limit)
 *          SUPA_PROJECT_URL     required
 *          SUPA_SERVICE_ROLE    required
 *          OPENROUTER_API_KEY   required
 */

import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createOpenAI } from '@ai-sdk/openai'
import { embed, generateText } from 'ai'
import { inferStatus, inferUrl, inferTech, detectGitProvider, parseCommitCount, buildRepoStats } from './sync-helpers.js'
import { loadPublicKeyFromEnv, loadPrivateKeyFromEnv, signEvidence } from '../src/lib/oep-key.js'
import { BANNED_PHRASES } from '../src/lib/score-resume.js'
import type { GitEvidence, EvidenceSignature } from '../src/types.js'

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

const MODEL = 'google/gemini-3-flash-preview'
// Default singleton profile row ID (UUID with trailing 1)
const PROFILE_ID = ['00000000', '0000', '0000', '0000', '000000000001'].join('-')

type RepoToSync = { slug: string; owner: string; repo: string }

function reposFromProfile(projects: ProjectEntry[]): RepoToSync[] {
  const results = []
  for (const p of projects) {
    const repoUrl = typeof p.repo === 'string' ? p.repo : null
    if (!repoUrl) continue
    const match = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(repoUrl)
    if (!match) continue
    const [, owner, repo] = match
    results.push({ slug: p.slug, owner, repo })
  }
  return results
}

// ── GitHub ────────────────────────────────────────────────

const GITHUB_API_VERSION = ['2022', '11', '28'].join('-') // YYYY-MM-DD per GitHub REST docs

async function fetchGitHubFile(owner: string, repo: string, path: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
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

interface RepoMetadata {
  pushedAt: string
  homepage: string | null
  createdAt: string
  defaultBranch: string
}

async function fetchRepoMetadata(owner: string, repo: string): Promise<RepoMetadata | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}`
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  }
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`
  const res = await fetch(url, { headers })
  if (!res.ok) {
    console.warn(`  GitHub metadata ${res.status} for ${owner}/${repo}`)
    return null
  }
  const data = await res.json() as {
    pushed_at?: string
    homepage?: string | null
    created_at?: string
    default_branch?: string
  }
  return {
    pushedAt: data.pushed_at ?? '',
    homepage: data.homepage ?? null,
    createdAt: data.created_at ?? '',
    defaultBranch: data.default_branch ?? 'main',
  }
}

// ── Git evidence ──────────────────────────────────────────

interface GitProvider {
  fetchCommitCount(owner: string, repo: string): Promise<number>
  fetchContributorCount(owner: string, repo: string): Promise<number | null>
}

class GitHubProvider implements GitProvider {
  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    }
    if (GITHUB_TOKEN) h['Authorization'] = `Bearer ${GITHUB_TOKEN}`
    return h
  }

  async fetchCommitCount(owner: string, repo: string): Promise<number> {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`,
      { headers: this.headers() },
    )
    if (!res.ok) return 0
    return parseCommitCount(res.headers.get('link')) ?? 1
  }

  async fetchContributorCount(owner: string, repo: string): Promise<number | null> {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/stats/contributors`,
      { headers: this.headers() },
    )
    // 202 = stats still computing — return null so caller preserves existing value
    if (res.status === 202) return null
    if (!res.ok) return null
    const data = await res.json() as unknown[]
    return Array.isArray(data) ? data.length : null
  }
}

// Stub providers — return zeros so they skip gracefully until implemented
class GitLabProvider implements GitProvider {
  async fetchCommitCount(_o: string, _r: string) { return 0 }
  async fetchContributorCount(_o: string, _r: string): Promise<number | null> { return null }
}
class BitbucketProvider implements GitProvider {
  async fetchCommitCount(_o: string, _r: string) { return 0 }
  async fetchContributorCount(_o: string, _r: string): Promise<number | null> { return null }
}

function getGitProvider(repoUrl: string): { provider: GitProvider; platform: GitEvidence['provider'] } | null {
  const p = detectGitProvider(repoUrl)
  if (p === 'github') return { provider: new GitHubProvider(), platform: 'github' }
  if (p === 'gitlab') return { provider: new GitLabProvider(), platform: 'gitlab' }
  if (p === 'bitbucket') return { provider: new BitbucketProvider(), platform: 'bitbucket' }
  return null
}

async function fetchGitEvidence(
  owner: string,
  repo: string,
  repoUrl: string,
  meta: RepoMetadata,
  tree: TreeEntry[],
  existing?: GitEvidence,
): Promise<GitEvidence | null> {
  const gp = getGitProvider(repoUrl)
  if (!gp) return null

  const [commitCount, contributorCountRaw] = await Promise.all([
    gp.provider.fetchCommitCount(owner, repo),
    gp.provider.fetchContributorCount(owner, repo),
  ])

  // Preserve existing contributor count when GitHub returns 202 (still computing)
  const contributors = contributorCountRaw ?? existing?.contributors ?? 0

  const repoStats = buildRepoStats(tree)

  return {
    verified_at: new Date().toISOString(),
    repo_created_at: meta.createdAt.slice(0, 10),
    last_push_at: meta.pushedAt.slice(0, 10),
    commit_count: commitCount,
    contributors,
    default_branch: meta.defaultBranch,
    provider: gp.platform,
    repo_stats: repoStats,
    source: repoUrl,
  }
}

// ── GitHub tree + feature doc fetching ────────────────────

interface TreeEntry { path: string; type: string }

async function fetchGitHubTree(owner: string, repo: string): Promise<TreeEntry[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  }
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`

  const res = await fetch(url, { headers })
  if (!res.ok) {
    console.warn(`  GitHub tree ${res.status} for ${owner}/${repo}`)
    return []
  }
  const data = await res.json() as { tree?: TreeEntry[] }
  return data.tree ?? []
}

/** Fetch .md files under given directory prefixes, capped at 30 files. */
async function fetchFeatureDocs(
  owner: string,
  repo: string,
  prefixes: string[],
  preloadedTree?: TreeEntry[],
): Promise<Array<{ path: string; content: string }>> {
  const tree = preloadedTree ?? await fetchGitHubTree(owner, repo)
  const mdFiles = tree
    .filter(e =>
      e.type === 'blob' &&
      e.path.endsWith('.md') &&
      prefixes.some(p => e.path.startsWith(p)),
    )
    .slice(0, 30) // rate-limit guard

  const results: Array<{ path: string; content: string }> = []
  for (const file of mdFiles) {
    const content = await fetchGitHubFile(owner, repo, file.path)
    if (content) results.push({ path: file.path, content })
  }
  return results
}

// ── Changelog section parsing ────────────────────────────

interface ChangelogSections { shipped: string; unreleased: string }

/** Split a CHANGELOG into shipped (versioned) and unreleased sections. */
export function splitChangelogSections(changelog: string): ChangelogSections {
  const lines = changelog.split('\n')
  let inUnreleased = false
  const shipped: string[] = []
  const unreleased: string[] = []

  for (const line of lines) {
    // Detect section headers: ## [Unreleased] vs ## [x.y.z]
    if (/^##\s*\[unreleased\]/i.test(line)) {
      inUnreleased = true
      continue
    }
    if (/^##\s*\[\d/.test(line)) {
      inUnreleased = false
      shipped.push(line)
      continue
    }
    ;(inUnreleased ? unreleased : shipped).push(line)
  }

  return {
    shipped: shipped.join('\n').trim(),
    unreleased: unreleased.join('\n').trim(),
  }
}

// ── Version drift detection ───────────────────────────────

interface SemVer { major: number; minor: number; patch: number }

function parseSemVer(v: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  if (!m) return null
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) }
}

function latestChangelogVersion(changelog: string): string | null {
  const m = /^##\s*\[?v?(\d+\.\d+\.\d+)/m.exec(changelog)
  return m ? m[1] : null
}

function isDriftSignificant(pkg: SemVer, log: SemVer): boolean {
  if (pkg.major > log.major) return true
  if (pkg.major === log.major && pkg.minor > log.minor) return true
  if (pkg.major === log.major && pkg.minor === log.minor && pkg.patch - log.patch > 1) return true
  return false
}

function driftLabel(pkgV: string, logV: string, pkg: SemVer, log: SemVer): string {
  if (pkg.major !== log.major) return `major: ${logV} → ${pkgV}`
  if (pkg.minor !== log.minor) return `minor: ${logV} → ${pkgV}`
  return `${pkg.patch - log.patch} unreleased patches: ${logV} → ${pkgV}`
}

async function warnVersionDrift(slug: string, pkgVersion: string, logVersion: string, label: string): Promise<void> {
  const message = `VERSION DRIFT [${slug}]: package.json@${pkgVersion} is ahead of CHANGELOG@${logVersion} (${label}) — sync highlights and thoughts reflect ${logVersion} only until a versioned CHANGELOG entry is added`
  try {
    const hash = contentHash(slug, `version-drift:${pkgVersion}:${logVersion}`)
    const { data: existing } = await supabase.from('thoughts').select('id').eq('content_hash', hash).limit(1)
    if (existing?.length) return
    const { embedding } = await embed({ model: openrouter.embedding('openai/text-embedding-3-small'), value: message })
    await supabase.from('thoughts').insert({
      content: message,
      embedding,
      content_hash: hash,
      metadata: { type: 'observation', source: 'sync', project: slug, topics: [slug, 'version_drift', 'sync_warning'] },
    })
  } catch (err) {
    console.warn(`  ⚠ version drift thought write failed (non-fatal): ${(err as Error).message}`)
  }
}

// ── Thought extraction + storage ─────────────────────────

interface ExtractedFact {
  fact: string
  status: 'shipped' | 'planned' | 'aspirational'
  category: 'ux' | 'infra' | 'product' | 'api'
  date: string | null
}

function contentHash(slug: string, fact: string): string {
  return createHash('sha256')
    .update(`${slug}:${fact.toLowerCase().replace(/\s+/g, ' ').trim()}`)
    .digest('hex')
}

async function extractFacts(
  projectSlug: string,
  docContent: string,
  defaultStatus: 'shipped' | 'planned' | 'aspirational',
): Promise<ExtractedFact[]> {
  const doc = stripMarkdown(docContent).slice(0, 8000)
  if (!doc.trim()) return []

  const { text } = await generateText({
    model: openrouter(MODEL),
    prompt: `You are a technical fact extractor for a developer portfolio.
Extract discrete, standalone facts from this document. Each fact must:
- Be a single sentence describing one concrete thing that was designed, built, or achieved
- Include a category: ux (design decisions, user flows, IA, accessibility, interaction patterns), infra (deployment, CI/CD, databases), product (features, business logic), api (endpoints, integrations)
- Include a date (YYYY-MM) if one is discernible from context, else null

Respond ONLY with a JSON array:
[{ "fact": "...", "category": "ux|infra|product|api", "date": "YYYY-MM|null" }]

Rules:
- Only extract facts containing specific technical detail (no generic statements like "improved performance")
- Each fact must be self-contained and understandable without the surrounding document
- Maximum 30 facts per document
- Include design decisions, interaction patterns, and information architecture — not just what was coded

Document (project: ${projectSlug}):
${doc}`,
    maxTokens: 1500,
  })

  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim()
    const parsed = JSON.parse(cleaned) as Array<{ fact: string; category: string; date: string | null }>
    return parsed.slice(0, 30).map(f => ({
      fact: f.fact,
      status: defaultStatus,
      category: (f.category as ExtractedFact['category']) || 'product',
      date: f.date,
    }))
  } catch {
    console.warn(`  ⚠ Could not parse extracted facts JSON — skipping`)
    return []
  }
}

async function storeThoughts(
  projectSlug: string,
  facts: ExtractedFact[],
): Promise<{ added: number; skipped: number; inserted: ExtractedFact[] }> {
  if (!facts.length) return { added: 0, skipped: 0, inserted: [] }

  // Compute hashes for all facts
  const factsWithHash = facts.map(f => ({
    ...f,
    hash: contentHash(projectSlug, f.fact),
  }))

  // Check which hashes already exist
  const { data: existing } = await supabase
    .from('thoughts')
    .select('content_hash')
    .in('content_hash', factsWithHash.map(f => f.hash))
  const existingHashes = new Set((existing ?? []).map(r => r.content_hash))

  const newFacts = factsWithHash.filter(f => !existingHashes.has(f.hash))
  const inserted: ExtractedFact[] = []

  // Batch insert with embeddings (5 at a time to avoid rate limits)
  for (let i = 0; i < newFacts.length; i += 5) {
    const batch = newFacts.slice(i, i + 5)
    for (const f of batch) {
      const attributed = `[${projectSlug} | ${f.date ?? 'unknown'} | ${f.category} | ${f.status}] ${f.fact}`
      const { embedding } = await embed({
        model: openrouter.embedding('openai/text-embedding-3-small'),
        value: attributed,
      })
      const { error } = await supabase.from('thoughts').insert({
        content: attributed,
        embedding,
        content_hash: f.hash,
        metadata: {
          type: 'reference',
          source: 'enrichment',
          project: projectSlug,
          category: f.category,
          status: f.status,
          date: f.date,
          topics: [projectSlug, f.category, f.status],
        },
      })
      if (error) {
        console.warn(`  ⚠ Failed to insert thought: ${error.message}`)
      } else {
        inserted.push(f)
      }
    }
  }

  return { added: inserted.length, skipped: factsWithHash.length - newFacts.length, inserted }
}

// ── Employment delta proposal ────────────────────────────

async function proposeEmploymentDelta(
  employment: ProfileRow['employment'],
  newThoughts: ExtractedFact[],
  projectSlug: string,
): Promise<void> {
  const shippedUx = newThoughts.filter(f => f.status === 'shipped' && f.category === 'ux')
  if (shippedUx.length === 0) return

  // Find the self-employed entry (or first entry)
  const selfEmployed = employment?.find(e =>
    e.company?.toLowerCase().includes('self-employed') ||
    e.company?.toLowerCase().includes('self employed'),
  )
  if (!selfEmployed) return

  const currentBullets = Array.isArray(selfEmployed.bullets) ? selfEmployed.bullets : []

  const { text } = await generateText({
    model: openrouter(MODEL),
    prompt: `You are reviewing employment bullets for a developer portfolio.
The candidate is self-employed and has recently shipped new UX work. Review the current bullets and the new achievements, then propose updated bullets that better represent the UX design work.

Current employment bullets:
${currentBullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Newly shipped UX achievements (from ${projectSlug}):
${shippedUx.map(f => `- ${f.fact}`).join('\n')}

Rules:
- Keep 4-6 bullets total
- Lead with UX design decisions, interaction patterns, and information architecture
- Include specific details: view counts, component counts, accessibility standards
- Do NOT fabricate — only use facts from the bullets and achievements above
- Respond ONLY with a JSON array of strings (the new bullets)`,
    maxTokens: 800,
  })

  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim()
    const proposed = JSON.parse(cleaned) as string[]

    const content = [
      `EMPLOYMENT DELTA PROPOSAL (${projectSlug}):`,
      `Generated: ${new Date().toISOString().slice(0, 10)}`,
      '',
      'Proposed self-employment bullets:',
      ...proposed.map((b, i) => `${i + 1}. ${b}`),
      '',
      'Current bullets:',
      ...currentBullets.map((b, i) => `${i + 1}. ${b}`),
    ].join('\n')

    const { embedding } = await embed({
      model: openrouter.embedding('openai/text-embedding-3-small'),
      value: content,
    })

    await supabase.from('thoughts').insert({
      content,
      embedding,
      metadata: {
        type: 'review_needed',
        source: 'sync',
        project: 'self-employed',
        topics: ['employment', 'review_needed', projectSlug],
      },
    })
    console.log(`  ✔ employment delta proposal written (review via MCP)`)
  } catch {
    console.warn(`  ⚠ Could not generate employment delta proposal`)
  }
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

interface EmploymentEntry {
  company?: string
  title?: string
  bullets?: string[]
  [key: string]: unknown
}

interface ProfileRow {
  projects: ProjectEntry[]
  skills?: Array<{ category?: string; items?: string[] | null }> | null
  employment?: EmploymentEntry[] | null
}

async function loadProfile(): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from('public_profile')
    .select('projects, skills, employment')
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

  // Heal any previously stored NO_CHANGE artifact before feeding to LLM
  const cleanedCurrent = currentArchitecture.replace(/\s*\bNO_CHANGE\b\s*$/i, '').trim()
  const wasCorrupted = cleanedCurrent !== currentArchitecture.trim()

  // Force rewrite if current value is raw markdown, empty, or was corrupted
  const forceRewrite = !cleanedCurrent || looksLikeRawMarkdown(cleanedCurrent) || wasCorrupted

  const { text } = await generateText({
    model: openrouter(MODEL),
    prompt: `You are maintaining the "architecture" field of a developer portfolio API.

Current value:
${cleanedCurrent || '(empty)'}

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
  // Strip any trailing NO_CHANGE token the model may append alongside real content
  const stripped = result.replace(/\s*\bNO_CHANGE\b\s*$/i, '').trim()
  const isNoChange = result === 'NO_CHANGE' || stripped === ''

  if (isNoChange) {
    if (!forceRewrite) return { updated: false, value: cleanedCurrent }
    // Model ignored the force-rewrite instruction — fall back to stripped doc
    return { updated: true, value: stripMarkdown(doc) }
  }
  return { updated: true, value: stripMarkdown(stripped) }
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
This is a curated list of the greatest achievements on the project — demonstrating both UX design judgment and engineering execution to a hiring engineer.

Current highlights:
${currentHighlights.length ? currentHighlights.map((h, i) => `${i + 1}. ${h}`).join('\n') : '(empty)'}

Full changelog:
${log}

Rules:
- Scan the changelog for significant achievements not already captured in the current highlights
- Surface UX design decisions (information architecture, interaction patterns, user flows, accessibility), not just infrastructure
- Add new entries for anything impressive: novel UX patterns designed, systems built, hard problems solved, meaningful scale or automation
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

interface SyncResult {
  projects: ProfileRow['projects']
  newThoughts: ExtractedFact[]
}

async function syncProject(
  r: RepoToSync,
  projects: ProfileRow['projects'],
): Promise<SyncResult> {
  const allNewThoughts: ExtractedFact[] = []
  const idx = projects.findIndex(p => p.slug === r.slug)
  if (idx < 0) {
    console.log(`  ⚠ "${r.slug}" not found in profile — skipping`)
    return { projects, newThoughts: allNewThoughts }
  }

  const project = projects[idx]
  const projectName = String(project.name ?? r.slug)
  const currentArchitecture = project.architecture ?? ''
  const currentHighlights = Array.isArray(project.highlights)
    ? (project.highlights as string[])
    : []

  // Fetch docs in parallel; always fetch README.md for URL inference even when
  // docsPath points to a custom architecture doc.
  const archPath = r.docsPath ?? 'README.md'
  const needsSeparateReadme = archPath !== 'README.md'
  const [archDoc, changelog, readmeDoc] = await Promise.all([
    fetchGitHubFile(r.owner, r.repo, archPath),
    fetchGitHubFile(r.owner, r.repo, 'CHANGELOG.md'),
    needsSeparateReadme ? fetchGitHubFile(r.owner, r.repo, 'README.md') : Promise.resolve(null),
  ])
  const readmeForUrl = needsSeparateReadme ? readmeDoc : archDoc

  let updated = false

  // ── Architecture reconciliation (unchanged) ──
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

  // ── Highlights reconciliation (now shipped-only) ──
  const skipChangelog = !!(project as { skipChangelog?: boolean }).skipChangelog
  if (skipChangelog) {
    console.log(`  — changelog skipped (skipChangelog: true) — highlights and changelog thoughts preserved as-is`)
  } else if (changelog) {
    const sections = splitChangelogSections(changelog)
    // Highlights only from shipped changelog (no ## [Unreleased])
    const hi = await reconcileHighlights(projectName, currentHighlights, sections.shipped)
    if (hi.updated) {
      project.highlights = hi.value
      updated = true
      console.log(`  ✔ highlights updated (${hi.value.length} entries)`)
    } else {
      console.log(`  — highlights unchanged`)
    }

    // ── Extract thoughts from shipped changelog ──
    console.log(`  Extracting thoughts from shipped changelog...`)
    const shippedFacts = await extractFacts(r.slug, sections.shipped, 'shipped')
    if (shippedFacts.length) {
      const result = await storeThoughts(r.slug, shippedFacts)
      console.log(`  ✔ changelog thoughts: ${result.added} added, ${result.skipped} skipped`)
      allNewThoughts.push(...result.inserted)
    }

    // ── Extract thoughts from unreleased (as planned) ──
    if (sections.unreleased) {
      const plannedFacts = await extractFacts(r.slug, sections.unreleased, 'planned')
      if (plannedFacts.length) {
        const result = await storeThoughts(r.slug, plannedFacts)
        console.log(`  ✔ unreleased thoughts: ${result.added} added, ${result.skipped} skipped`)
      }
    }
  } else {
    console.log(`  ⚠ CHANGELOG.md not found — skipping highlights + thought extraction`)
  }

  // ── Repo tree (needed for git evidence + feature docs) ───
  const repoTree = await fetchGitHubTree(r.owner, r.repo)

  // ── Status / URL / Tech inference ────────────────────────
  const meta = await fetchRepoMetadata(r.owner, r.repo)
  if (meta) {
    const newStatus = inferStatus(meta.pushedAt, project.status ?? '')
    if (newStatus) {
      project.status = newStatus
      updated = true
      console.log(`  ✔ status inferred: ${newStatus}`)
    } else {
      console.log(`  — status unchanged`)
    }

    const newUrl = inferUrl(readmeForUrl, meta.homepage, project.url as string | undefined)
    if (newUrl) {
      project.url = newUrl
      updated = true
      console.log(`  ✔ url inferred: ${newUrl}`)
    } else {
      console.log(`  — url unchanged`)
    }
  }

  const pkgJson = await fetchGitHubFile(r.owner, r.repo, 'package.json')
  const newTech = inferTech(pkgJson, project.tech as string[] | undefined)
  if (newTech) {
    project.tech = newTech
    updated = true
    console.log(`  ✔ tech merged (${newTech.length} entries)`)
  } else {
    console.log(`  — tech unchanged`)
  }

  // ── Version drift detection ───────────────────────────────
  if (pkgJson && changelog) {
    let pkgParsed: { version?: string } = {}
    try { pkgParsed = JSON.parse(pkgJson) } catch { /* ignore */ }
    const pkgVer = pkgParsed.version ? parseSemVer(pkgParsed.version) : null
    const logVerStr = latestChangelogVersion(changelog)
    const logVer = logVerStr ? parseSemVer(logVerStr) : null
    if (pkgVer && logVer && isDriftSignificant(pkgVer, logVer)) {
      const label = driftLabel(pkgParsed.version!, logVerStr!, pkgVer, logVer)
      console.warn(`  ⚠ version drift: ${label}`)
      await warnVersionDrift(r.slug, pkgParsed.version!, logVerStr!, label)
    }
  }

  // ── Git evidence ──────────────────────────────────────────
  if (meta && project.repo) {
    const repoUrl = String(project.repo)
    const evidence = await fetchGitEvidence(r.owner, r.repo, repoUrl, meta, repoTree, project.git_evidence as GitEvidence | undefined)
    if (evidence) {
      // Sign the evidence if OEP keys are configured — best-effort, never abort sync on failure
      try {
        const baseUrl = process.env.PUBLIC_URL?.replace(/\/$/, '')
        if (!baseUrl?.startsWith('http')) {
          console.log(`  — git_evidence signing skipped: PUBLIC_URL not set or not absolute`)
        } else {
          const privKey = loadPrivateKeyFromEnv()
          const pubLoaded = loadPublicKeyFromEnv()
          if (privKey && pubLoaded) {
            const { signature: _existing, ...payload } = evidence
            const sig: EvidenceSignature = {
              alg: 'ed25519',
              key_url: `${baseUrl}/.well-known/oep-public-key.json`,
              fingerprint: pubLoaded.fingerprint,
              value: signEvidence(payload, privKey),
              signed_at: new Date().toISOString(),
            }
            evidence.signature = sig
            console.log(`  ✔ git_evidence signed (fingerprint: ${pubLoaded.fingerprint.slice(0, 12)}…)`)
          } else {
            console.log(`  — git_evidence signing skipped: OEP keys not configured`)
          }
        }
      } catch (err) {
        console.warn(`  ⚠ git_evidence signing failed (non-fatal): ${(err as Error).message}`)
      }
      project.git_evidence = evidence
      updated = true
      console.log(`  ✔ git_evidence updated (${evidence.commit_count} commits, ${evidence.repo_stats.total_files} files)`)
    } else {
      console.log(`  — git_evidence skipped (unsupported provider)`)
    }
  }

  // ── Extract thoughts from feature docs ──
  const prefixes = (r as { featureDocsGlobs?: string[] }).featureDocsGlobs
  if (prefixes?.length) {
    console.log(`  Fetching feature docs (${prefixes.join(', ')})...`)
    const docs = await fetchFeatureDocs(r.owner, r.repo, prefixes, repoTree)
    console.log(`  Found ${docs.length} doc(s)`)
    for (const doc of docs) {
      // Docs under plans/ directories are planned; others are shipped
      const status = doc.path.includes('/plans/') ? 'planned' as const : 'shipped' as const
      const facts = await extractFacts(r.slug, doc.content, status)
      if (facts.length) {
        const result = await storeThoughts(r.slug, facts)
        console.log(`    ${doc.path}: ${result.added} added, ${result.skipped} skipped`)
        if (status === 'shipped') allNewThoughts.push(...result.inserted)
      }
    }
  }

  if (updated) projects[idx] = { ...project }
  return { projects, newThoughts: allNewThoughts }
}

// ── Employment consolidation ─────────────────────────────
//
// Controlled entirely by env vars — disabled by default (opt-in).
// When enabled, reads the most recent employment delta proposal from OB1,
// runs a rubric gate, and applies it to the self-employed entry.
// Writes a notification thought so the candidate knows what changed.

interface ConsolidationConfig {
  enabled: boolean
  strategy: 'replace' | 'additive'
  minBullets: number
  rubricGate: boolean
  frequency: 'weekly' | 'on_change' | 'always'
}

function getConsolidationConfig(): ConsolidationConfig {
  const rawMinBullets = parseInt(process.env.EMPLOYMENT_SYNC_MIN_BULLETS ?? '3', 10)
  const minBullets = Number.isFinite(rawMinBullets) && rawMinBullets >= 1 ? rawMinBullets : 3

  const rawStrategy = process.env.EMPLOYMENT_SYNC_STRATEGY ?? 'replace'
  const strategy: 'replace' | 'additive' = rawStrategy === 'additive' ? 'additive' : 'replace'

  const rawFrequency = process.env.EMPLOYMENT_SYNC_FREQUENCY ?? 'weekly'
  const frequency: 'weekly' | 'on_change' | 'always' =
    rawFrequency === 'on_change' ? 'on_change' : rawFrequency === 'always' ? 'always' : 'weekly'

  return {
    enabled: process.env.EMPLOYMENT_SYNC_ENABLED === 'true',
    strategy,
    minBullets,
    rubricGate: process.env.EMPLOYMENT_SYNC_RUBRIC_GATE !== 'false',
    frequency,
  }
}

/** Parse proposed bullets out of a delta proposal thought. */
function parseDeltaProposal(content: string): string[] | null {
  const match = content.match(/Proposed self-employment bullets:\s*\n([\s\S]*?)(?:\n\nCurrent bullets:|$)/)
  if (!match) return null
  const bullets = match[1].trim().split('\n')
    .map(l => l.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean)
  return bullets.length >= 1 ? bullets : null
}

/** Rubric gate: no banned phrases + quantified ratio must not regress >20%. */
function passesRubricGate(
  proposed: string[],
  current: string[],
  config: ConsolidationConfig,
): { pass: boolean; reason: string } {
  if (!config.rubricGate) return { pass: true, reason: 'gate disabled' }
  if (proposed.length < config.minBullets) {
    return { pass: false, reason: `too few bullets: ${proposed.length} < ${config.minBullets}` }
  }
  const joined = proposed.join(' ').toLowerCase()
  const found = BANNED_PHRASES.filter(p => joined.includes(p))
  if (found.length > 0) return { pass: false, reason: `banned phrase: ${found.join(', ')}` }
  const metricRe = /\d+%|\$[\d,.]+|\b\d{2,}\b|\d+x\b|\d+\+/
  const currentRatio = current.length > 0 ? current.filter(b => metricRe.test(b)).length / current.length : 0
  const proposedRatio = proposed.filter(b => metricRe.test(b)).length / proposed.length
  if (currentRatio > 0 && proposedRatio < currentRatio * 0.8) {
    return { pass: false, reason: `quantified ratio regressed: ${(currentRatio * 100).toFixed(0)}% → ${(proposedRatio * 100).toFixed(0)}%` }
  }
  return { pass: true, reason: `banned_phrases=pass, quantified=${(proposedRatio * 100).toFixed(0)}%` }
}

/** Check frequency gate — returns true if we should apply now. */
async function shouldApplyNow(
  proposed: string[],
  current: string[],
  config: ConsolidationConfig,
): Promise<boolean> {
  if (config.frequency === 'always') return true
  if (config.frequency === 'on_change') {
    const h = (arr: string[]) => createHash('sha256').update(arr.join('|')).digest('hex')
    return h(proposed) !== h(current)
  }
  // weekly: skip if already applied within 7 days
  const { data } = await supabase
    .from('thoughts')
    .select('created_at')
    .contains('metadata', { topics: ['employment_sync_applied'] })
    .order('created_at', { ascending: false })
    .limit(1)
  if (!data || data.length === 0) return true
  const daysSince = (Date.now() - new Date(data[0].created_at as string).getTime()) / 86_400_000
  return daysSince >= 7
}

async function consolidateEmployment(employment: ProfileRow['employment']): Promise<void> {
  const config = getConsolidationConfig()
  if (!config.enabled) {
    console.log('  — employment consolidation disabled (set EMPLOYMENT_SYNC_ENABLED=true to enable)')
    return
  }

  // Find most recent delta proposal
  const { data: proposals } = await supabase
    .from('thoughts')
    .select('content, created_at')
    .contains('metadata', { type: 'review_needed', topics: ['employment'] })
    .order('created_at', { ascending: false })
    .limit(1)
  if (!proposals?.length) {
    console.log('  — no delta proposals found in OB1')
    return
  }

  const proposed = parseDeltaProposal(proposals[0].content)
  if (!proposed) {
    console.warn('  ⚠ could not parse proposed bullets from delta proposal')
    return
  }

  const selfEmployed = employment?.find(e =>
    e.company?.toLowerCase().includes('self-employed') || e.company?.toLowerCase().includes('self employed'),
  )
  if (!selfEmployed) {
    console.log('  — no self-employed entry found in profile')
    return
  }
  const currentBullets = Array.isArray(selfEmployed.bullets) ? selfEmployed.bullets as string[] : []

  // Frequency gate
  if (!await shouldApplyNow(proposed, currentBullets, config)) {
    console.log('  — employment consolidation skipped (frequency gate)')
    return
  }

  // Rubric gate
  const gate = passesRubricGate(proposed, currentBullets, config)
  if (!gate.pass) {
    console.log(`  ⚠ employment consolidation skipped — rubric gate failed: ${gate.reason}`)
    return
  }

  // Apply
  const finalBullets = config.strategy === 'additive'
    ? [...new Set([...currentBullets, ...proposed])]
    : proposed

  const updatedEmployment = (employment ?? []).map(e =>
    (e.company?.toLowerCase().includes('self-employed') || e.company?.toLowerCase().includes('self employed'))
      ? { ...e, bullets: finalBullets }
      : e,
  )

  const { error } = await supabase
    .from('public_profile')
    .update({ employment: updatedEmployment, updated_at: new Date().toISOString() })
    .eq('id', PROFILE_ID)
  if (error) {
    console.warn(`  ⚠ employment consolidation failed: ${error.message}`)
    return
  }
  console.log(`  ✔ employment bullets updated: ${currentBullets.length} → ${finalBullets.length} (${config.strategy})`)

  // Notification thought
  const notification = [
    `[sync | ${new Date().toISOString().slice(0, 10)} | notification] Employment bullets updated automatically.`,
    `Strategy: ${config.strategy} | Bullets: ${currentBullets.length} → ${finalBullets.length} | Rubric: ${gate.reason}`,
    '',
    'New bullets:',
    ...finalBullets.map((b, i) => `${i + 1}. ${b}`),
    '',
    'Previous bullets archived:',
    ...currentBullets.map((b, i) => `${i + 1}. ${b}`),
  ].join('\n')

  try {
    const { embedding } = await embed({
      model: openrouter.embedding('openai/text-embedding-3-small'),
      value: notification,
    })
    await supabase.from('thoughts').insert({
      content: notification,
      embedding,
      metadata: {
        type: 'notification',
        source: 'sync',
        topics: ['employment', 'employment_sync_applied', 'notification'],
      },
    })
    console.log('  ✔ notification written to OB1 (search "employment updated" in private MCP)')
  } catch (err) {
    console.warn(`  ⚠ notification write failed (non-fatal): ${(err as Error).message}`)
  }
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
  const allNewThoughts: ExtractedFact[] = []
  const REPOS = reposFromProfile(projects)

  if (REPOS.length === 0) {
    console.warn('No GitHub repos found in profile.projects — skipping per-repo sync.')
  }

  for (const r of REPOS) {
    console.log(`Syncing ${r.slug}...`)
    const result = await syncProject(r, projects)
    projects = result.projects
    allNewThoughts.push(...result.newThoughts)
  }

  await saveProjects(projects)
  console.log('\nProjects saved.')

  // Propose employment bullet updates if new UX work was shipped
  if (allNewThoughts.length > 0 && profile.employment) {
    console.log('\nProposing employment delta...')
    await proposeEmploymentDelta(profile.employment, allNewThoughts, 'all-projects')
  }

  // Consolidate employment bullets from most recent proposal (opt-in via env var)
  console.log('\nConsolidating employment...')
  await consolidateEmployment(profile.employment)

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
