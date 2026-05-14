/**
 * Unit tests — thought-metadata helpers (src/lib/thought-metadata.ts).
 *
 * The privacy invariant: `metadata.private` is set ONLY from the explicit
 * caller argument, never from model-extracted metadata. This guards against
 * model drift / prompt injection where the extraction emits `"private": true`
 * or `"source": "..."` inside the blob. The same invariant extends to
 * `resolveThoughtUpdateOpts`: on edit, `private` is preserved from the existing
 * row unless the caller overrides it, and `source` provenance is never lost.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildThoughtMetadata, resolveThoughtUpdateOpts } from '../src/lib/thought-metadata.js'

describe('buildThoughtMetadata', () => {
  it('passes through extracted content keys and stamps source', () => {
    const out = buildThoughtMetadata({ type: 'observation', topics: ['x'], people: ['Y'] }, { source: 'mcp' })
    assert.deepEqual(out, { type: 'observation', topics: ['x'], people: ['Y'], source: 'mcp' })
  })

  it('omits `private` entirely when not requested (absent = public)', () => {
    const out = buildThoughtMetadata({ type: 'observation' }, { source: 'mcp' })
    assert.ok(!('private' in out))
  })

  it('sets `private: true` only when explicitly requested', () => {
    const out = buildThoughtMetadata({ type: 'observation' }, { source: 'mcp', private: true })
    assert.equal(out.private, true)
  })

  it('strips a model-emitted `private` key when the caller did NOT request privacy', () => {
    // model drift / prompt injection: extraction tried to set private:true
    const out = buildThoughtMetadata({ type: 'observation', private: true }, { source: 'mcp' })
    assert.ok(!('private' in out), 'extracted private:true must not survive')
  })

  it('caller `private:true` wins even if extraction also set it', () => {
    const out = buildThoughtMetadata({ type: 'observation', private: true }, { source: 'mcp', private: true })
    assert.equal(out.private, true)
  })

  it('caller `private` unset wins even over extracted private:false noise', () => {
    const out = buildThoughtMetadata({ type: 'observation', private: false }, { source: 'mcp' })
    assert.ok(!('private' in out))
  })

  it('strips a model-emitted `source` key and uses the explicit one', () => {
    const out = buildThoughtMetadata({ type: 'observation', source: 'evil' }, { source: 'mcp' })
    assert.equal(out.source, 'mcp')
  })

  it('handles null / non-object extracted metadata', () => {
    assert.deepEqual(buildThoughtMetadata(null, { source: 'mcp' }), { source: 'mcp' })
    assert.deepEqual(buildThoughtMetadata('not an object', { source: 'mcp' }), { source: 'mcp' })
    assert.deepEqual(buildThoughtMetadata(['array'], { source: 'mcp' }), { source: 'mcp' })
    assert.deepEqual(buildThoughtMetadata(undefined, { source: 'mcp', private: true }), { source: 'mcp', private: true })
  })
})

describe('resolveThoughtUpdateOpts', () => {
  it('preserves source and private from existing metadata when no override given', () => {
    const out = resolveThoughtUpdateOpts({ source: 'sync', private: true }, {})
    assert.deepEqual(out, { source: 'sync', private: true })
  })

  it('treats a public existing row as public when no override', () => {
    const out = resolveThoughtUpdateOpts({ source: 'mcp' }, {})
    assert.deepEqual(out, { source: 'mcp', private: false })
  })

  it('caller override `private: true` flips a public thought to private', () => {
    const out = resolveThoughtUpdateOpts({ source: 'mcp' }, { private: true })
    assert.equal(out.private, true)
  })

  it('caller override `private: false` flips a private thought to public', () => {
    // Critical: `false` must be respected, not treated as "leave unchanged".
    const out = resolveThoughtUpdateOpts({ source: 'mcp', private: true }, { private: false })
    assert.equal(out.private, false)
  })

  it('falls back to source="mcp" when existing source is missing or malformed', () => {
    assert.equal(resolveThoughtUpdateOpts({}, {}).source, 'mcp')
    assert.equal(resolveThoughtUpdateOpts({ source: '' }, {}).source, 'mcp')
    assert.equal(resolveThoughtUpdateOpts({ source: 123 }, {}).source, 'mcp')
  })

  it('handles null / non-object existing metadata without throwing', () => {
    assert.deepEqual(resolveThoughtUpdateOpts(null, {}), { source: 'mcp', private: false })
    assert.deepEqual(resolveThoughtUpdateOpts(undefined, { private: true }), { source: 'mcp', private: true })
    assert.deepEqual(resolveThoughtUpdateOpts(['array'], {}), { source: 'mcp', private: false })
  })

  it('treats a truthy-but-non-true existing `private` as public', () => {
    // metadata.private comes from JSONB — guard against accidentally truthy strings.
    const out = resolveThoughtUpdateOpts({ source: 'mcp', private: 'yes' }, {})
    assert.equal(out.private, false)
  })
})
