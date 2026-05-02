/**
 * Unit tests — injectProjectUrls
 *
 * Verifies that server-side injection always prefers profile url/repo over
 * whatever the model returned, handles malformed JSONB safely, and leaves
 * unmatched projects untouched.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { injectProjectUrls } from '../src/routes/resume.js'
import type { Project } from '../src/types.js'

const base = (slug: string, overrides: Partial<Project> = {}): Project => ({
  name: slug,
  slug,
  description: '',
  problem: '',
  role: '',
  tech: [],
  highlights: [],
  status: 'active',
  ...overrides,
})

describe('injectProjectUrls', () => {
  it('returns empty array when generated is undefined', () => {
    assert.deepEqual(injectProjectUrls(undefined, [{ slug: 'a', url: 'https://a.com' }]), [])
  })

  it('returns generated unchanged when profileProjects is empty', () => {
    const gen = [base('a')]
    assert.deepEqual(injectProjectUrls(gen, []), gen)
  })

  it('returns generated unchanged when profileProjects is not an array', () => {
    const gen = [base('a')]
    assert.deepEqual(injectProjectUrls(gen, null), gen)
    assert.deepEqual(injectProjectUrls(gen, 'bad'), gen)
  })

  it('profile url always wins over model url', () => {
    const gen = [base('a', { url: 'https://hallucinated.com' })]
    const profile = [{ slug: 'a', url: 'https://canonical.com', repo: 'https://github.com/u/a' }]
    const result = injectProjectUrls(gen, profile)
    assert.equal(result[0].url, 'https://canonical.com')
  })

  it('profile repo always wins over model repo', () => {
    const gen = [base('a', { repo: 'https://hallucinated-repo.com' })]
    const profile = [{ slug: 'a', repo: 'https://github.com/u/a' }]
    const result = injectProjectUrls(gen, profile)
    assert.equal(result[0].repo, 'https://github.com/u/a')
  })

  it('clears url/repo when profile has none', () => {
    const gen = [base('a', { url: 'https://model-url.com', repo: 'https://model-repo.com' })]
    const profile = [{ slug: 'a' }]
    const result = injectProjectUrls(gen, profile)
    assert.equal(result[0].url, undefined)
    assert.equal(result[0].repo, undefined)
  })

  it('leaves unmatched slug untouched', () => {
    const gen = [base('x', { url: 'https://x.com' })]
    const profile = [{ slug: 'y', url: 'https://y.com' }]
    const result = injectProjectUrls(gen, profile)
    assert.equal(result[0].url, 'https://x.com')
  })

  it('skips null entries in profile JSONB without throwing', () => {
    const gen = [base('a')]
    const profile = [null, { slug: 'a', url: 'https://canonical.com' }, undefined]
    assert.doesNotThrow(() => injectProjectUrls(gen, profile))
    const result = injectProjectUrls(gen, profile)
    assert.equal(result[0].url, 'https://canonical.com')
  })

  it('skips profile entries missing slug without throwing', () => {
    const gen = [base('a', { url: 'https://model.com' })]
    const profile = [{ url: 'https://no-slug.com' }, { slug: 'a', url: 'https://canonical.com' }]
    assert.doesNotThrow(() => injectProjectUrls(gen, profile))
    const result = injectProjectUrls(gen, profile)
    assert.equal(result[0].url, 'https://canonical.com')
  })
})
