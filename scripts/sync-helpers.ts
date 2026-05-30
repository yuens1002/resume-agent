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
