/**
 * Unit tests — parseHiddenProjectSlugs (shared HIDE_FROM_PROJECTS parser, #176)
 *
 * `filterVisibleProjects` already has thorough coverage in
 * tests/inject-project-urls.test.ts (via its resume.ts re-export); this file
 * covers only the parser, which is new shared surface extracted out of
 * src/routes/resume.ts so /query can use the identical mechanism.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseHiddenProjectSlugs } from '../src/lib/hidden-projects.js'

describe('parseHiddenProjectSlugs', () => {
  it('returns an empty Set when the env value is undefined', () => {
    const result = parseHiddenProjectSlugs(undefined)
    assert.ok(result instanceof Set)
    assert.equal(result.size, 0)
  })

  it('returns an empty Set when the env value is an empty string', () => {
    const result = parseHiddenProjectSlugs('')
    assert.equal(result.size, 0)
  })

  it('parses a single slug', () => {
    const result = parseHiddenProjectSlugs('brew-guide')
    assert.deepEqual([...result], ['brew-guide'])
  })

  it('parses multiple comma-separated slugs', () => {
    const result = parseHiddenProjectSlugs('brew-guide,artisan-roast-platform')
    assert.deepEqual([...result].sort(), ['artisan-roast-platform', 'brew-guide'])
  })

  it('trims surrounding whitespace around each slug', () => {
    const result = parseHiddenProjectSlugs('  brew-guide , artisan-roast-platform  ')
    assert.deepEqual([...result].sort(), ['artisan-roast-platform', 'brew-guide'])
  })

  it('drops empty entries from stray/trailing commas', () => {
    const result = parseHiddenProjectSlugs('brew-guide,,artisan-roast-platform,')
    assert.deepEqual([...result].sort(), ['artisan-roast-platform', 'brew-guide'])
  })

  it('drops an entry that is whitespace-only', () => {
    const result = parseHiddenProjectSlugs('brew-guide,   ,artisan-roast-platform')
    assert.deepEqual([...result].sort(), ['artisan-roast-platform', 'brew-guide'])
  })
})
