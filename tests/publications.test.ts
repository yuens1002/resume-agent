/**
 * Unit tests — mergePublication (src/lib/publications.ts, #177 chunk 1).
 *
 * Pure find-by-slug upsert logic backing the `upsert_publication` MCP tool.
 * No DB, no network — mirrors the pattern in public-mcp-action-intent.test.ts.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergePublication } from '../src/lib/publications.js'
import type { Publication } from '../src/types.js'

function samplePublication(overrides: Partial<Publication> = {}): Publication {
  return {
    title: 'Why Agentic Workflows Fail',
    slug: 'why-agentic-workflows-fail',
    platform: 'Dev.to',
    canonical_url: 'https://dev.to/alex/why-agentic-workflows-fail',
    date: '2026-07-01',
    tags: ['agents', 'workflows'],
    grounded_in: 'knowledge_base/wiki/insights/agentic-workflow-failure-modes.md',
    ...overrides,
  }
}

describe('mergePublication', () => {
  it('inserts a new publication when the slug is new', () => {
    const result = mergePublication([], {
      slug: 'new-piece',
      title: 'New Piece',
      platform: 'X',
      canonical_url: 'https://x.com/alex/status/1',
      date: '2026-07-11',
      tags: ['oep'],
      grounded_in: 'knowledge_base/wiki/insights/oep.md',
    })

    assert.ok(result.ok, 'expected a successful insert')
    if (!result.ok) return
    assert.equal(result.action, 'added')
    assert.equal(result.publications.length, 1)
    assert.equal(result.publications[0].slug, 'new-piece')
    assert.equal(result.publications[0].title, 'New Piece')
  })

  it('updates an existing publication by slug, merging only provided fields', () => {
    const existing = samplePublication()
    const result = mergePublication([existing], {
      slug: existing.slug,
      canonical_url: 'https://alex.dev/why-agentic-workflows-fail',
    })

    assert.ok(result.ok, 'expected a successful update')
    if (!result.ok) return
    assert.equal(result.action, 'updated')
    assert.equal(result.publications.length, 1)
    const updated = result.publications[0]
    assert.equal(updated.canonical_url, 'https://alex.dev/why-agentic-workflows-fail', 'canonical_url should be updated')
    assert.equal(updated.title, existing.title, 'title should be preserved from the existing record')
    assert.deepEqual(updated.tags, existing.tags, 'tags should be preserved from the existing record')
  })

  it('preserves other publications untouched when updating one by slug', () => {
    const other = samplePublication({ slug: 'other-piece', title: 'Other Piece' })
    const target = samplePublication()
    const result = mergePublication([other, target], {
      slug: target.slug,
      title: 'Renamed Title',
    })

    assert.ok(result.ok, 'expected a successful update')
    if (!result.ok) return
    assert.equal(result.publications.length, 2)
    const untouched = result.publications.find((p) => p.slug === 'other-piece')
    const renamed = result.publications.find((p) => p.slug === target.slug)
    assert.deepEqual(untouched, other, 'the unrelated publication must be byte-for-byte unchanged')
    assert.equal(renamed?.title, 'Renamed Title')
  })

  it('rejects a new-slug insert missing required fields', () => {
    const result = mergePublication([], { slug: 'incomplete' })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /Missing required field\(s\)/)
    assert.match(result.error, /title/)
    assert.match(result.error, /platform/)
    assert.match(result.error, /canonical_url/)
    assert.match(result.error, /date/)
    assert.match(result.error, /tags/)
    assert.match(result.error, /grounded_in/)
  })

  it('allows a partial update on an existing slug with no other fields provided', () => {
    const existing = samplePublication()
    const result = mergePublication([existing], { slug: existing.slug })

    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.action, 'updated')
    assert.deepEqual(result.publications[0], existing)
  })
})
