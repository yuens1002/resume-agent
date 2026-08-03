/**
 * Pure helper functions for the GitHub-to-OB1 sync pipeline.
 *
 * Extracted here so they can be unit-tested without importing the
 * full sync.ts entry point (which has side-effectful top-level code).
 */

// ── inferStatus ───────────────────────────────────────────

/** Thresholds in days */
const ACTIVE_THRESHOLD_DAYS = 60
const ARCHIVE_THRESHOLD_DAYS = 365

/**
 * Infer project status from last GitHub push date.
 *
 * Returns the new status string, or null if no change is warranted.
 * Never returns 'in-progress' — that is a human-set transitional state.
 *
 * @param pushedAt  ISO date string from GitHub repo metadata
 * @param currentStatus  Existing status value in the profile
 * @param now  Override current date (for testing)
 */
export function inferStatus(
  pushedAt: string,
  currentStatus: string,
  now: Date = new Date(),
): string | null {
  const pushed = new Date(pushedAt)
  if (isNaN(pushed.getTime())) return null

  const ageDays = (now.getTime() - pushed.getTime()) / (1000 * 60 * 60 * 24)

  if (ageDays <= ACTIVE_THRESHOLD_DAYS) {
    return currentStatus === 'active' ? null : 'active'
  }
  if (ageDays > ARCHIVE_THRESHOLD_DAYS) {
    return currentStatus === 'archived' ? null : 'archived'
  }
  // 61–365 days: keep existing, don't guess
  return null
}

// ── inferUrl ──────────────────────────────────────────────

/**
 * Infer a project's live URL from GitHub metadata and README content.
 *
 * Only fires when currentUrl is falsy — never overwrites a manually-set URL.
 * Priority: GitHub repo homepage field → README deployment patterns.
 */
export function inferUrl(
  readme: string | null,
  homepage: string | null,
  currentUrl: string | undefined,
): string | null {
  if (currentUrl) return null

  // GitHub repo homepage is the most reliable signal
  if (homepage?.startsWith('https://') || homepage?.startsWith('http://')) {
    return homepage
  }

  if (!readme) return null

  // Match "Production ... endpoint: https://..." or "Live at https://..."
  const deployPatterns = [
    /\*\*Production[^:]*:\*\*\s*`?\s*(https?:\/\/[^\s)`\]]+)/i,
    /Production[^:]*:\s*`?\s*(https?:\/\/[^\s)`\]]+)/i,
    /Live at[:\s]+`?\s*(https?:\/\/[^\s)`\]]+)/i,
    /Deployed at[:\s]+`?\s*(https?:\/\/[^\s)`\]]+)/i,
    /Demo[:\s]+`?\s*(https?:\/\/[^\s)`\]]+)/i,
  ]
  for (const pat of deployPatterns) {
    const m = readme.match(pat)
    if (m?.[1]) return m[1].replace(/[.,;]$/, '')
  }

  // Badge link pattern: [![...](img)](https://...)
  const badgeLink = /\[!\[.*?\]\(.*?\)\]\((https?:\/\/[^\s)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = badgeLink.exec(readme)) !== null) {
    const url = m[1]
    // Skip GitHub, shields.io, and other meta-service URLs
    if (!/github\.com|shields\.io|badge|img\.shields/.test(url)) {
      return url
    }
  }

  return null
}

// ── inferTech ─────────────────────────────────────────────

/** Maps npm package names to canonical portfolio display names. */
export const PACKAGE_TO_DISPLAY: Record<string, string> = {
  '@anthropic-ai/sdk': 'Anthropic Claude',
  '@modelcontextprotocol/sdk': 'MCP (@modelcontextprotocol/sdk)',
  'ai': 'Vercel AI SDK',
  '@ai-sdk/anthropic': 'Vercel AI SDK',
  '@ai-sdk/openai': 'Vercel AI SDK',
  '@ai-sdk/google': 'Vercel AI SDK',
  'hono': 'Hono',
  '@supabase/supabase-js': 'Supabase',
  '@prisma/client': 'Prisma',
  'prisma': 'Prisma',
  'zod': 'Zod',
  'next': 'Next.js',
  'react': 'React',
  'stripe': 'Stripe',
  'next-auth': 'NextAuth.js v5',
  'vitest': 'Vitest',
  'jest': 'Jest',
  '@playwright/test': 'Playwright',
  'playwright': 'Playwright',
  'tailwindcss': 'Tailwind CSS',
  'langchain': 'LangChain',
  'openai': 'OpenAI SDK',
}

const TECH_CAP = 15

/**
 * Infer tech stack entries from a project's package.json content.
 *
 * Merges inferred entries with existing manual tech (additive — never removes).
 * Returns the merged array, or null if nothing new was added.
 */
export function inferTech(
  packageJson: string | null,
  currentTech: string[] | undefined,
): string[] | null {
  if (!packageJson) return null

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(packageJson)
  } catch {
    return null
  }

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  }

  const inferred = new Set<string>()
  for (const [name, displayName] of Object.entries(PACKAGE_TO_DISPLAY)) {
    if (name in allDeps) {
      inferred.add(displayName)
    }
  }

  if (inferred.size === 0) return null

  const existing = new Set(currentTech ?? [])
  const newEntries = [...inferred].filter(t => !existing.has(t))
  if (newEntries.length === 0) return null

  const merged = [...(currentTech ?? []), ...newEntries]
  return merged.slice(0, TECH_CAP)
}

// ── Git evidence helpers ──────────────────────────────────

/**
 * Detect which git hosting provider a repo URL belongs to.
 * Returns null for unsupported/unrecognised hosts.
 */
export function detectGitProvider(repoUrl: string): 'github' | 'gitlab' | 'bitbucket' | null {
  try {
    const { hostname } = new URL(repoUrl)
    if (hostname === 'github.com') return 'github'
    if (hostname === 'gitlab.com') return 'gitlab'
    if (hostname === 'bitbucket.org') return 'bitbucket'
  } catch {
    // invalid URL
  }
  return null
}

/**
 * Parse the total commit count from GitHub's Link response header.
 *
 * GitHub returns a Link header like:
 *   <https://api.github.com/repos/owner/repo/commits?per_page=1&page=142>; rel="last"
 * The page number equals total commits when per_page=1.
 *
 * Returns null if the header is absent, malformed, or the repo has only one page
 * (single-page repos have no `last` rel — caller should treat null as 0/unknown).
 */
export function parseCommitCount(linkHeader: string | null | undefined): number | null {
  if (!linkHeader) return null
  const match = /[?&]page=(\d+)>;\s*rel="last"/.exec(linkHeader)
  if (!match?.[1]) return null
  const n = parseInt(match[1], 10)
  return isNaN(n) ? null : n
}

export interface RepoStats {
  total_files: number
  typescript_files: number
  test_files: number
}

/**
 * Count file types from a GitHub tree response.
 * Only counts blobs (files), not trees (directories).
 */
export function buildRepoStats(tree: Array<{ path: string; type: string }>): RepoStats {
  let total_files = 0
  let typescript_files = 0
  let test_files = 0

  for (const entry of tree) {
    if (entry.type !== 'blob') continue
    total_files++
    const p = entry.path
    if ((p.endsWith('.ts') || p.endsWith('.tsx')) && !p.endsWith('.d.ts')) typescript_files++
    if (/[/\\]tests?[/\\]|\.test\.[tj]sx?$|\.spec\.[tj]sx?$/.test(p)) test_files++
  }

  return { total_files, typescript_files, test_files }
}

/**
 * Metadata for the employment-delta proposal the sync writes when it detects a
 * drift between the profile's self-employment bullets and what the projects now
 * show (`writeEmploymentDeltaProposal` in sync.ts).
 *
 * `private: true` is the load-bearing part. These rows carry **LLM-proposed
 * résumé bullets awaiting owner approval** — by construction that includes
 * proposals the owner read and rejected. Without the flag they are
 * public-eligible (`isPublicThought` treats a missing `private` as public), and
 * 60 of them were readable at `GET /observations?type=review_needed` before this
 * was fixed. The writer's own log line already called them owner-only —
 * "employment delta proposal written (review via MCP)" — the metadata just
 * didn't say so.
 *
 * For a surface whose contract is "your agent is your truth", an unapproved
 * draft claim about the candidate's own work history is the one category that
 * most directly undercuts it: it is precisely not vetted truth.
 *
 * Lives here rather than in sync.ts because that module self-executes on
 * import, which would make the invariant untestable.
 */
export function buildEmploymentDeltaMetadata(projectSlug: string): Record<string, unknown> {
  return {
    type: 'review_needed',
    source: 'sync',
    private: true,
    project: 'self-employed',
    topics: ['employment', 'review_needed', projectSlug],
  }
}

/**
 * Metadata for the notification the sync writes after it automatically replaces
 * the profile's employment bullets (`notifyEmploymentSyncApplied` in sync.ts).
 *
 * `private: true` for the same reason as {@link buildEmploymentDeltaMetadata},
 * with a wrinkle: the row publishes the new bullets *and* the ones they
 * replaced, under a "Previous bullets archived" heading. The new set is already
 * public via `GET /info`; the archived set is not — it is résumé text the owner
 * has since moved away from, and republishing superseded claims is the same
 * "not vetted truth" problem the delta proposals had.
 *
 * The writer's own log line already treated it as owner-only: "notification
 * written to OB1 (search \"employment updated\" in private MCP)".
 */
export function buildEmploymentNotificationMetadata(): Record<string, unknown> {
  return {
    type: 'notification',
    source: 'sync',
    private: true,
    topics: ['employment', 'employment_sync_applied', 'notification'],
  }
}
