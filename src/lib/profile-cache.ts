// Shared fetch + cache for the canonical profile row.
//
// Every public read path (query, info, availability, projects, verify, resume,
// match, agent-card, public-mcp) renders from the same single `public_profile`
// row. This module is the one place that decides how that row is fetched, how
// long it is cached, and what happens when Supabase is unreachable.
//
// Failure policy (motivated by the 2026-07-24 outage, where a transient
// Railway → Supabase network failure turned every endpoint into a 404):
//   - Fresh cache (5-min TTL): profile changes at most a few times per day, so
//     a short TTL eliminates one Supabase round-trip per request. Callers may
//     see data up to 5 minutes stale after a profile update — acceptable, and
//     write paths call invalidateProfileCache() to shrink that window.
//   - Stale-on-error: if the fetch fails but a last-known-good row exists,
//     serve it (marked `stale`) instead of taking the whole site down.
//   - `not_found` vs `unavailable`: only PostgREST's "zero rows" error means
//     the row genuinely doesn't exist (→ 404). Every other failure is a
//     transport/upstream error (→ 503) and must not masquerade as a 404.
import { supabase } from './supabase.js'

/** The singleton profile row id — one profile per deployed instance. */
export const PROFILE_ID = '00000000-0000-0000-0000-000000000001'

const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000

// Bounds worst-case request latency when Supabase's edge is unresponsive
// (observed hangs of ~20s per request during the 2026-07-24 outage). On
// timeout the fetch fails fast and the stale-on-error fallback kicks in.
const PROFILE_FETCH_TIMEOUT_MS = 8_000

// PostgREST error code for `.single()` matching zero rows — the only error
// that means "the row does not exist" rather than "the fetch failed".
const POSTGREST_NO_ROWS = 'PGRST116'

// Intentionally loose: the profile is owner-defined JSON and routes cast the
// fields they read — matches the untyped supabase-js rows this replaces.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProfileRow = Record<string, any>

export type ProfileFetchResult =
  | { kind: 'ok'; profile: ProfileRow; stale: boolean }
  | { kind: 'not_found' }
  | { kind: 'unavailable' }

/**
 * HTTP mapping for the two failure kinds — one registry so every route
 * returns identical status/body for the same failure.
 */
export const PROFILE_ERROR_HTTP = {
  not_found: { status: 404, body: { error: 'Profile not found' } },
  unavailable: { status: 503, body: { error: 'Profile temporarily unavailable — retry shortly' } },
} as const

interface RawFetchOutcome {
  data: unknown
  error: { code?: string; message?: string } | null
}

type ProfileRowFetcher = () => Promise<RawFetchOutcome>

// async so the PostgrestBuilder thenable resolves to a plain RawFetchOutcome
const defaultRowFetcher: ProfileRowFetcher = async () =>
  supabase
    .from('public_profile')
    .select('*')
    .eq('id', PROFILE_ID)
    .abortSignal(AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS))
    .single()

let rowFetcher: ProfileRowFetcher = defaultRowFetcher

let lastGood: ProfileRow | null = null
let freshUntil = 0

/** Upstream error pages (e.g. Cloudflare HTML) can be huge — log a bounded slice. */
function truncateForLog(message: string | undefined): string {
  const text = message ?? 'unknown error'
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

export async function fetchProfile(): Promise<ProfileFetchResult> {
  const now = Date.now()
  if (lastGood && now < freshUntil) {
    return { kind: 'ok', profile: lastGood, stale: false }
  }

  let outcome: RawFetchOutcome
  try {
    outcome = await rowFetcher()
  } catch (err: unknown) {
    // supabase-js normally returns errors in-band; a throw here is a
    // transport-level failure (abort, DNS, TLS) — same policy as `error`.
    outcome = { data: null, error: { message: (err as Error).message } }
  }

  if (!outcome.error && outcome.data) {
    lastGood = outcome.data as ProfileRow
    freshUntil = now + PROFILE_CACHE_TTL_MS
    return { kind: 'ok', profile: lastGood, stale: false }
  }

  if (outcome.error?.code === POSTGREST_NO_ROWS) {
    // Authoritative "row absent" from PostgREST. Drop the stale copy — serving
    // a deleted profile would misrepresent, and a 404 here is truthful.
    lastGood = null
    freshUntil = 0
    return { kind: 'not_found' }
  }

  console.error(
    `[profile-cache] fetch failed${lastGood ? ' — serving last-known-good' : ''}: ${truncateForLog(outcome.error?.message)}`,
  )
  if (lastGood) {
    // Do NOT extend freshUntil: keep retrying the live fetch on every request
    // until it recovers, serving the stale copy in the meantime.
    return { kind: 'ok', profile: lastGood, stale: true }
  }
  return { kind: 'unavailable' }
}

/**
 * Force revalidation on the next read — called by write paths after a
 * successful profile update. Keeps the last-known-good copy as failover;
 * it only clears the freshness window.
 */
export function invalidateProfileCache(): void {
  freshUntil = 0
}

/**
 * Test-only: swap the row fetcher and reset all cache state.
 * Pass null to restore the real Supabase-backed fetcher.
 */
export function __setProfileRowFetcherForTests(fetcher: ProfileRowFetcher | null): void {
  rowFetcher = fetcher ?? defaultRowFetcher
  lastGood = null
  freshUntil = 0
}
