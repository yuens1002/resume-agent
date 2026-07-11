/**
 * Unit tests — scripts/eval/eval-cache.ts (#201)
 *
 * Verifies the result-cache key derivation (deterministic, sensitive to
 * every input dimension) and the load/save round-trip.
 *
 * Run: npm run test:unit
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheKey, loadCache, saveCache } from '../scripts/eval/eval-cache.js'

test('cacheKey: identical inputs produce identical keys', () => {
  const a = cacheKey('rule', 'question', 'model', 'provider', 1)
  const b = cacheKey('rule', 'question', 'model', 'provider', 1)
  assert.equal(a, b)
})

test('cacheKey: changes when rule changes', () => {
  const a = cacheKey('rule-a', 'question', 'model', 'provider', 1)
  const b = cacheKey('rule-b', 'question', 'model', 'provider', 1)
  assert.notEqual(a, b)
})

test('cacheKey: changes when question changes', () => {
  const a = cacheKey('rule', 'question-a', 'model', 'provider', 1)
  const b = cacheKey('rule', 'question-b', 'model', 'provider', 1)
  assert.notEqual(a, b)
})

test('cacheKey: changes when model changes', () => {
  const a = cacheKey('rule', 'question', 'model-a', 'provider', 1)
  const b = cacheKey('rule', 'question', 'model-b', 'provider', 1)
  assert.notEqual(a, b)
})

test('cacheKey: changes when provider changes', () => {
  const a = cacheKey('rule', 'question', 'model', 'provider-a', 1)
  const b = cacheKey('rule', 'question', 'model', 'provider-b', 1)
  assert.notEqual(a, b)
})

test('cacheKey: changes when round changes', () => {
  const a = cacheKey('rule', 'question', 'model', 'provider', 1)
  const b = cacheKey('rule', 'question', 'model', 'provider', 2)
  assert.notEqual(a, b)
})

test('loadCache: missing path returns {} without throwing', () => {
  const missing = join(tmpdir(), `eval-cache-missing-${Date.now()}.json`)
  assert.deepEqual(loadCache(missing), {})
})

test('saveCache -> loadCache: round-trips through a temp path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-cache-test-'))
  const path = join(dir, 'nested', 'verdicts.json')
  try {
    const data = { abc123: 'narrate', def456: 'open_match_tool' }
    saveCache(data, path)
    assert.deepEqual(loadCache(path), data)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveCache: writes keys in sorted order regardless of insertion order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-cache-sort-'))
  const path = join(dir, 'verdicts.json')
  try {
    // Insertion order deliberately unsorted — a concurrency pool inserts in
    // completion order, which must not leak into the committed file's diff.
    saveCache({ zzz: 'narrate', aaa: 'open_match_tool', mmm: 'narrate_fit' }, path)
    const raw = readFileSync(path, 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['aaa', 'mmm', 'zzz'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
