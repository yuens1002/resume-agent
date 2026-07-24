/**
 * Unit tests — src/lib/profile-cache.ts
 *
 * Verifies the shared profile fetch policy: fresh-TTL caching,
 * stale-on-error last-known-good failover, the not_found vs unavailable
 * distinction, and write-path invalidation.
 *
 * The system clock is pinned via t.mock.timers (never real time — see
 * feedback_time_dependent_tests) and the Supabase row fetcher is swapped
 * for a counting stub via __setProfileRowFetcherForTests.
 *
 * Run: npm run test:unit
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchProfile,
  invalidateProfileCache,
  __setProfileRowFetcherForTests,
} from '../src/lib/profile-cache.js'

const PROFILE_TTL_MS = 5 * 60 * 1000

const okRow = (marker: string) => ({ data: { updated_at: marker }, error: null })
const transportError = { data: null, error: { message: '<!DOCTYPE html> … cloudflare error page …' } }
const noRows = { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }

/** Install a fetcher that replays `outcomes` in order (last one repeats), counting calls. */
function stubFetcher(...outcomes: Array<{ data: unknown; error: { code?: string; message: string } | null }>) {
  let calls = 0
  __setProfileRowFetcherForTests(async () => {
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)]
    calls++
    return outcome
  })
  return { count: () => calls }
}

test('fetchProfile: success returns the row, not stale', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  t.after(() => __setProfileRowFetcherForTests(null))
  stubFetcher(okRow('v1'))

  const result = await fetchProfile()
  assert.equal(result.kind, 'ok')
  assert.equal(result.kind === 'ok' && result.stale, false)
  assert.equal(result.kind === 'ok' && result.profile.updated_at, 'v1')
})

test('fetchProfile: second call within TTL is served from cache (no refetch)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  t.after(() => __setProfileRowFetcherForTests(null))
  const fetcher = stubFetcher(okRow('v1'))

  await fetchProfile()
  t.mock.timers.tick(PROFILE_TTL_MS - 1)
  await fetchProfile()
  assert.equal(fetcher.count(), 1)
})

test('fetchProfile: refetches after the TTL elapses', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  t.after(() => __setProfileRowFetcherForTests(null))
  const fetcher = stubFetcher(okRow('v1'), okRow('v2'))

  await fetchProfile()
  t.mock.timers.tick(PROFILE_TTL_MS + 1)
  const result = await fetchProfile()
  assert.equal(fetcher.count(), 2)
  assert.equal(result.kind === 'ok' && result.profile.updated_at, 'v2')
})

test('fetchProfile: transport error after a success serves last-known-good, marked stale', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  t.mock.method(console, 'error', () => {})
  t.after(() => __setProfileRowFetcherForTests(null))
  stubFetcher(okRow('v1'), transportError)

  await fetchProfile()
  t.mock.timers.tick(PROFILE_TTL_MS + 1)
  const result = await fetchProfile()
  assert.equal(result.kind, 'ok')
  assert.equal(result.kind === 'ok' && result.stale, true)
  assert.equal(result.kind === 'ok' && result.profile.updated_at, 'v1')
})

test('fetchProfile: stale serving does not stop retrying — recovery picks up the live row', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  t.mock.method(console, 'error', () => {})
  t.after(() => __setProfileRowFetcherForTests(null))
  const fetcher = stubFetcher(okRow('v1'), transportError, okRow('v2'))

  await fetchProfile()
  t.mock.timers.tick(PROFILE_TTL_MS + 1)
  await fetchProfile()               // error → stale v1, must NOT re-arm the TTL
  const result = await fetchProfile() // retries immediately, recovers
  assert.equal(fetcher.count(), 3)
  assert.equal(result.kind === 'ok' && result.stale, false)
  assert.equal(result.kind === 'ok' && result.profile.updated_at, 'v2')
})

test('fetchProfile: transport error with no cached copy → unavailable', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  t.mock.method(console, 'error', () => {})
  t.after(() => __setProfileRowFetcherForTests(null))
  stubFetcher(transportError)

  const result = await fetchProfile()
  assert.equal(result.kind, 'unavailable')
})

test('fetchProfile: a thrown fetcher (abort/DNS/TLS) is treated as a transport error', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  t.mock.method(console, 'error', () => {})
  __setProfileRowFetcherForTests(async () => { throw new Error('The operation was aborted') })
  t.after(() => __setProfileRowFetcherForTests(null))

  const result = await fetchProfile()
  assert.equal(result.kind, 'unavailable')
})

test('fetchProfile: PGRST116 (zero rows) → not_found, and drops the stale copy', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  t.mock.method(console, 'error', () => {})
  t.after(() => __setProfileRowFetcherForTests(null))
  stubFetcher(okRow('v1'), noRows, transportError)

  await fetchProfile()
  t.mock.timers.tick(PROFILE_TTL_MS + 1)
  const deleted = await fetchProfile()
  assert.equal(deleted.kind, 'not_found')

  // A deleted row must not resurrect via stale-on-error failover
  const afterward = await fetchProfile()
  assert.equal(afterward.kind, 'unavailable')
})

test('invalidateProfileCache: forces a refetch within the TTL but keeps failover', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  t.mock.method(console, 'error', () => {})
  t.after(() => __setProfileRowFetcherForTests(null))
  const fetcher = stubFetcher(okRow('v1'), transportError)

  await fetchProfile()
  invalidateProfileCache()
  const result = await fetchProfile() // within TTL, but invalidated → refetches; fetch fails → stale v1
  assert.equal(fetcher.count(), 2)
  assert.equal(result.kind === 'ok' && result.stale, true)
  assert.equal(result.kind === 'ok' && result.profile.updated_at, 'v1')
})
