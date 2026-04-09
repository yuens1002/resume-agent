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

// The pure helpers below are currently re-implemented locally for unit
// testing because sync.ts is a script entry point, not an importable
// module. These tests do not currently exercise the production
// implementation directly; once the helpers are extracted to a shared
// module, this file should import them instead of duplicating them.

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
