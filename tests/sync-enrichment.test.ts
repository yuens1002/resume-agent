/**
 * Unit tests — sync enrichment helpers
 *
 * Tests the pure functions extracted for the OB1 enrichment pipeline:
 * splitChangelogSections, contentHash dedup logic.
 *
 * No network, no LLM calls.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { inferStatus, inferUrl, inferTech, PACKAGE_TO_DISPLAY, parseCommitCount, buildRepoStats, detectGitProvider } from '../scripts/sync-helpers.js'

// ── splitChangelogSections (re-implemented for test) ─────

interface ChangelogSections { shipped: string; unreleased: string }

function splitChangelogSections(changelog: string): ChangelogSections {
  const lines = changelog.split('\n')
  let inUnreleased = false
  const shipped: string[] = []
  const unreleased: string[] = []

  for (const line of lines) {
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

// ── contentHash (re-implemented for test) ────────────────

function contentHash(slug: string, fact: string): string {
  return createHash('sha256')
    .update(`${slug}:${fact.toLowerCase().replace(/\s+/g, ' ').trim()}`)
    .digest('hex')
}

// ── Tests ────────────────────────────────────────────────

describe('splitChangelogSections', () => {
  it('separates shipped (versioned) from unreleased', () => {
    const changelog = `# Changelog

## [Unreleased]

- feat: upcoming feature A
- feat: upcoming feature B

## [1.2.0] — 2026-04-01

- feat: shipped feature X
- fix: shipped bug Y

## [1.1.0] — 2026-03-15

- feat: older shipped feature Z
`
    const sections = splitChangelogSections(changelog)

    assert.ok(sections.shipped.includes('shipped feature X'), 'shipped should contain versioned entries')
    assert.ok(sections.shipped.includes('older shipped feature Z'), 'shipped should contain older versions')
    assert.ok(!sections.shipped.includes('upcoming feature A'), 'shipped should NOT contain unreleased')

    assert.ok(sections.unreleased.includes('upcoming feature A'), 'unreleased should contain unreleased entries')
    assert.ok(sections.unreleased.includes('upcoming feature B'), 'unreleased should contain all unreleased')
    assert.ok(!sections.unreleased.includes('shipped feature X'), 'unreleased should NOT contain shipped')
  })

  it('handles changelog with no unreleased section', () => {
    const changelog = `# Changelog

## [1.0.0] — 2026-01-01

- Initial release
`
    const sections = splitChangelogSections(changelog)
    assert.ok(sections.shipped.includes('Initial release'))
    assert.equal(sections.unreleased, '')
  })

  it('handles changelog with only unreleased section', () => {
    const changelog = `# Changelog

## [Unreleased]

- Work in progress
`
    const sections = splitChangelogSections(changelog)
    assert.ok(sections.unreleased.includes('Work in progress'))
    assert.equal(sections.shipped, '# Changelog')
  })

  it('handles empty changelog', () => {
    const sections = splitChangelogSections('')
    assert.equal(sections.shipped, '')
    assert.equal(sections.unreleased, '')
  })

  it('is case-insensitive for [Unreleased] header', () => {
    const changelog = `## [UNRELEASED]

- planned item

## [0.1.0]

- shipped item
`
    const sections = splitChangelogSections(changelog)
    assert.ok(sections.unreleased.includes('planned item'))
    assert.ok(sections.shipped.includes('shipped item'))
  })
})

// ── inferStatus ──────────────────────────────────────────

describe('inferStatus', () => {
  const now = new Date('2026-05-30T00:00:00Z')

  it('returns "active" when pushed within 60 days', () => {
    const pushed = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    assert.equal(inferStatus(pushed, 'in-progress', now), 'active')
  })

  it('returns null when already active and pushed within 60 days', () => {
    const pushed = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString()
    assert.equal(inferStatus(pushed, 'active', now), null)
  })

  it('returns null when pushed 61–365 days ago (keep existing)', () => {
    const pushed = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000).toISOString()
    assert.equal(inferStatus(pushed, 'in-progress', now), null)
    assert.equal(inferStatus(pushed, 'active', now), null)
  })

  it('returns "archived" when pushed > 365 days ago', () => {
    const pushed = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString()
    assert.equal(inferStatus(pushed, 'active', now), 'archived')
  })

  it('returns null when already archived and pushed > 365 days ago', () => {
    const pushed = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString()
    assert.equal(inferStatus(pushed, 'archived', now), null)
  })

  it('returns "active" when previously archived project is pushed within 60 days', () => {
    const pushed = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString()
    assert.equal(inferStatus(pushed, 'archived', now), 'active')
  })

  it('returns null for invalid date string', () => {
    assert.equal(inferStatus('not-a-date', 'active', now), null)
  })
})

// ── inferUrl ────────────────────────────────────────────

describe('inferUrl', () => {
  it('returns null when currentUrl is already set', () => {
    assert.equal(inferUrl('readme text', 'https://example.com', 'https://existing.com'), null)
  })

  it('returns GitHub homepage when set and currentUrl is empty', () => {
    assert.equal(inferUrl(null, 'https://myproject.com', undefined), 'https://myproject.com')
  })

  it('extracts "Production MCP endpoint:" URL from README', () => {
    const readme = '**Production MCP endpoint:** `https://brew-guide-production.up.railway.app/mcp`'
    assert.equal(inferUrl(readme, null, undefined), 'https://brew-guide-production.up.railway.app/mcp')
  })

  it('extracts "Live at" URL from README', () => {
    const readme = 'Live at https://agent.yuens.me — fully operational.'
    assert.equal(inferUrl(readme, null, undefined), 'https://agent.yuens.me')
  })

  it('skips GitHub and shields.io badge links', () => {
    const readme = '[![CI](https://github.com/org/repo/actions)](https://github.com/org/repo)'
    assert.equal(inferUrl(readme, null, undefined), null)
  })

  it('returns null when no URL found and currentUrl is empty', () => {
    assert.equal(inferUrl('Just some text with no URL.', null, undefined), null)
  })

  it('prefers homepage over README patterns', () => {
    const readme = 'Live at https://readme-url.com'
    assert.equal(inferUrl(readme, 'https://homepage-url.com', undefined), 'https://homepage-url.com')
  })
})

// ── inferTech ────────────────────────────────────────────

describe('inferTech', () => {
  it('returns null when packageJson is null', () => {
    assert.equal(inferTech(null, ['TypeScript']), null)
  })

  it('returns null for invalid JSON', () => {
    assert.equal(inferTech('not json', []), null)
  })

  it('maps @anthropic-ai/sdk to "Anthropic Claude"', () => {
    const pkg = JSON.stringify({ dependencies: { '@anthropic-ai/sdk': '^1.0.0' } })
    const result = inferTech(pkg, [])
    assert.ok(result?.includes('Anthropic Claude'), `expected Anthropic Claude in ${result}`)
  })

  it('maps @modelcontextprotocol/sdk to MCP display name', () => {
    const pkg = JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } })
    const result = inferTech(pkg, [])
    assert.ok(result?.includes('MCP (@modelcontextprotocol/sdk)'), `expected MCP in ${result}`)
  })

  it('deduplicates Vercel AI SDK when multiple ai-sdk packages are present', () => {
    const pkg = JSON.stringify({
      dependencies: { 'ai': '^4.0.0', '@ai-sdk/anthropic': '^1.0.0', '@ai-sdk/openai': '^1.0.0' },
    })
    const result = inferTech(pkg, [])
    const count = result?.filter(t => t === 'Vercel AI SDK').length ?? 0
    assert.equal(count, 1, 'Vercel AI SDK should appear exactly once')
  })

  it('preserves manual tech entries not in package.json', () => {
    const pkg = JSON.stringify({ dependencies: { 'hono': '^4.0.0' } })
    const result = inferTech(pkg, ['Railway', 'OEP'])
    assert.ok(result?.includes('Railway'), 'manual Railway entry should be preserved')
    assert.ok(result?.includes('OEP'), 'manual OEP entry should be preserved')
    assert.ok(result?.includes('Hono'), 'inferred Hono should be added')
  })

  it('returns null when all inferred entries are already in currentTech', () => {
    const pkg = JSON.stringify({ dependencies: { 'hono': '^4.0.0' } })
    assert.equal(inferTech(pkg, ['Hono']), null)
  })

  it('caps result at 15 entries', () => {
    const existing = Array.from({ length: 13 }, (_, i) => `Tech${i}`)
    const pkg = JSON.stringify({
      dependencies: Object.fromEntries(Object.keys(PACKAGE_TO_DISPLAY).map(k => [k, '1.0.0'])),
    })
    const result = inferTech(pkg, existing)
    assert.ok(!result || result.length <= 15, `result length ${result?.length} exceeds 15`)
  })
})

// ── contentHash ──────────────────────────────────────────

describe('contentHash', () => {
  it('produces deterministic hash for same input', () => {
    const a = contentHash('artisan-roast', 'Built a menu builder')
    const b = contentHash('artisan-roast', 'Built a menu builder')
    assert.equal(a, b)
  })

  it('produces different hashes for different facts', () => {
    const a = contentHash('artisan-roast', 'Built a menu builder')
    const b = contentHash('artisan-roast', 'Built an admin dashboard')
    assert.notEqual(a, b)
  })

  it('produces different hashes for different projects', () => {
    const a = contentHash('artisan-roast', 'Built a menu builder')
    const b = contentHash('resume-agent', 'Built a menu builder')
    assert.notEqual(a, b)
  })

  it('normalises whitespace before hashing', () => {
    const a = contentHash('slug', 'Built   a   menu   builder')
    const b = contentHash('slug', 'Built a menu builder')
    assert.equal(a, b)
  })

  it('is case-insensitive', () => {
    const a = contentHash('slug', 'Built a Menu Builder')
    const b = contentHash('slug', 'built a menu builder')
    assert.equal(a, b)
  })
})

// ── detectGitProvider ────────────────────────────────────

describe('detectGitProvider', () => {
  it('detects github.com', () => assert.equal(detectGitProvider('https://github.com/owner/repo'), 'github'))
  it('detects gitlab.com', () => assert.equal(detectGitProvider('https://gitlab.com/owner/repo'), 'gitlab'))
  it('detects bitbucket.org', () => assert.equal(detectGitProvider('https://bitbucket.org/owner/repo'), 'bitbucket'))
  it('returns null for unknown host', () => assert.equal(detectGitProvider('https://codeberg.org/owner/repo'), null))
  it('returns null for empty string', () => assert.equal(detectGitProvider(''), null))
})

// ── parseCommitCount ─────────────────────────────────────

describe('parseCommitCount', () => {
  it('parses page number from standard GitHub Link header', () => {
    const header = '<https://api.github.com/repos/o/r/commits?per_page=1&page=142>; rel="last", <https://api.github.com/repos/o/r/commits?per_page=1&page=2>; rel="next"'
    assert.equal(parseCommitCount(header), 142)
  })

  it('returns null for null header', () => assert.equal(parseCommitCount(null), null))
  it('returns null for undefined header', () => assert.equal(parseCommitCount(undefined), null))
  it('returns null for empty string', () => assert.equal(parseCommitCount(''), null))

  it('returns null for single-page repo (no last rel)', () => {
    const header = '<https://api.github.com/repos/o/r/commits?per_page=1&page=1>; rel="first"'
    assert.equal(parseCommitCount(header), null)
  })

  it('returns null for malformed header', () => {
    assert.equal(parseCommitCount('not a link header at all'), null)
  })
})

// ── buildRepoStats ───────────────────────────────────────

describe('buildRepoStats', () => {
  const makeTree = (entries: Array<{ path: string; type?: string }>) =>
    entries.map(e => ({ path: e.path, type: e.type ?? 'blob' }))

  it('returns zeros for empty tree', () => {
    const stats = buildRepoStats([])
    assert.deepEqual(stats, { total_files: 0, typescript_files: 0, test_files: 0 })
  })

  it('counts total blob entries, not directories', () => {
    const tree = makeTree([
      { path: 'src', type: 'tree' },
      { path: 'src/index.ts' },
      { path: 'src/lib.ts' },
    ])
    assert.equal(buildRepoStats(tree).total_files, 2)
  })

  it('counts .ts and .tsx files but not .d.ts', () => {
    const tree = makeTree([
      { path: 'src/index.ts' },
      { path: 'src/app.tsx' },
      { path: 'src/types.d.ts' },
      { path: 'src/util.js' },
    ])
    const stats = buildRepoStats(tree)
    assert.equal(stats.typescript_files, 2)
  })

  it('counts test files by path pattern', () => {
    const tree = makeTree([
      { path: 'tests/unit.test.ts' },
      { path: 'src/__tests__/foo.spec.tsx' },
      { path: 'tests/helpers/util.ts' },
      { path: 'src/index.ts' },
    ])
    const stats = buildRepoStats(tree)
    // tests/unit.test.ts, src/__tests__/foo.spec.tsx match; tests/helpers/util.ts matches /tests?/ dir
    assert.ok(stats.test_files >= 2, `expected ≥2 test files, got ${stats.test_files}`)
  })
})
