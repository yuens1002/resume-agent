/**
 * Unit tests — buildThoughtMetadata (src/lib/thought-metadata.ts).
 *
 * The privacy invariant: `metadata.private` is set ONLY from the explicit
 * caller argument, never from model-extracted metadata. This guards against
 * model drift / prompt injection where the extraction emits `"private": true`
 * or `"source": "..."` inside the blob.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildThoughtMetadata } from '../src/lib/thought-metadata.js'

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
