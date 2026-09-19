// Time-bounded fetch for the shared Supabase client (#286).
//
// supabase-js has no request timeout of its own. When the database is degraded
// (connections queueing, disk IO exhausted), a PostgREST call can stay open for
// minutes, and every HTTP request waiting on it stays open too. Wrapping the
// client's `global.fetch` puts one ceiling under every call the shared client
// makes (PostgREST, RPC, storage, auth). supabase-js's own `db.timeout` option
// is not used because it bounds only the PostgREST client, not storage or auth.
//
// A timed-out PostgREST call surfaces the way any transport failure does:
// supabase-js catches the rejection and returns it in-band as `{ error }`
// (message prefixed `TimeoutError:`), so existing `if (error)` handling applies.
//
// Lives apart from `supabase.ts` so the constant and the factory can be
// imported without the env vars that module requires at load time.

/**
 * Upper bound on any single request made through the shared Supabase client.
 *
 * This is a ceiling, not a target. It is set well above normal call latency so
 * heavier calls (snapshot materialization RPCs, storage uploads, maintenance
 * scripts that import the shared client) keep headroom, while a degraded
 * database fails requests in seconds rather than the minutes observed without
 * it. Call sites that need a tighter bound pass their own abort signal; the two
 * are combined, so whichever fires first wins.
 */
export const SUPABASE_FETCH_TIMEOUT_MS = 30_000

type FetchFn = typeof fetch

/**
 * Wrap a fetch implementation so every call aborts after `timeoutMs`.
 *
 * A caller-supplied signal (on `init`, or on a `Request` passed as `input`) is
 * combined with the timeout via `AbortSignal.any`, never replaced, so callers
 * can still cancel early. On timeout the underlying fetch rejects with the
 * signal's `TimeoutError` reason.
 *
 * `baseFetch` defaults to the global fetch, resolved at call time rather than
 * captured at creation, so a fetch installed later is still the one used.
 */
export function createBoundedFetch(
  timeoutMs: number = SUPABASE_FETCH_TIMEOUT_MS,
  baseFetch?: FetchFn,
): FetchFn {
  return (input, init) => {
    const callerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal
    return (baseFetch ?? globalThis.fetch)(input, { ...init, signal })
  }
}
