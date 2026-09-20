// Background cleanup for the OAuth server (#286): the in-memory authorization
// code sweep and the database prune of old refresh-token rows.
//
// The two run on separate timers so neither can starve the other:
//   - The auth-code sweep is synchronous, in-memory and cheap; it keeps the
//     short cadence it has always had.
//   - The token prune is a database DELETE. On a degraded database it can take
//     longer than its own interval, and a fixed-rate timer with no guard then
//     stacks statements on top of each other, adding load to the database that
//     is already struggling. It is single-flight: a tick is skipped while the
//     previous prune is still pending, and the guard is released however that
//     prune settles (success, in-band error, rejection or synchronous throw).
//
// This module takes the prune and the sweep as callbacks, so it has no
// database or env dependency and can be driven directly under fake timers.

/**
 * How often expired authorization codes are evicted from memory. Codes live
 * for minutes, so this stays short.
 */
export const AUTH_CODE_SWEEP_INTERVAL_MS = 60_000

/**
 * How often the refresh-token table is pruned. Refresh tokens live for days
 * and rows are kept for a further multi-day retention period after expiry, so
 * removing a row up to one interval after it becomes eligible is immaterial.
 * The interval is far shorter than the token lifetime and far longer than a
 * healthy prune, so overlap stays unlikely even on a slow database.
 */
export const OAUTH_TOKEN_PRUNE_INTERVAL_MS = 60 * 60 * 1000

/**
 * Delay before the first prune after start. Short enough that a service which
 * restarts more often than the interval still prunes, long enough to stay out
 * of the way of boot work and of a database that is still recovering.
 */
export const OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS = 60_000

/** Shape of a supabase-js mutation result; only `error` is read. */
export interface TokenPruneResult {
  error: { message: string } | null
}

export type TokenPrune = () => PromiseLike<TokenPruneResult>

export interface OAuthCleanupOptions {
  /** Deletes old refresh-token rows. May resolve with an in-band error or reject. */
  prune: TokenPrune
  /** Evicts expired authorization codes from memory. */
  sweepAuthCodes: () => void
  pruneIntervalMs?: number
  sweepIntervalMs?: number
  /** Delay before the first prune. Defaults to OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS. */
  firstPruneDelayMs?: number
  /** Defaults to console.error. */
  logError?: (message: string, detail?: unknown) => void
}

export interface OAuthCleanupHandle {
  /**
   * Run one prune now, honouring the single-flight guard. Resolves `false`
   * without calling `prune` when a prune is already pending. Never rejects.
   */
  runPrune: () => Promise<boolean>
  /** Whether a prune is currently pending. */
  isPruneInFlight: () => boolean
  /** Clears every timer. */
  stop: () => void
  /** Exposed so callers and tests can confirm every timer is unref'd. */
  timers: {
    prune: ReturnType<typeof setInterval>
    sweep: ReturnType<typeof setInterval>
    firstPrune: ReturnType<typeof setTimeout>
  }
}

const LOG_PREFIX = '[oauth] cleanup:'

/**
 * Start the auth-code sweep and the single-flight token prune. Both timers are
 * unref'd, so they never keep the process alive on their own. The first prune
 * runs `firstPruneDelayMs` after start; the interval takes over from there.
 */
export function startOAuthTokenCleanup(options: OAuthCleanupOptions): OAuthCleanupHandle {
  const {
    prune,
    sweepAuthCodes,
    pruneIntervalMs = OAUTH_TOKEN_PRUNE_INTERVAL_MS,
    sweepIntervalMs = AUTH_CODE_SWEEP_INTERVAL_MS,
    firstPruneDelayMs = OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS,
    logError = (message, detail) => console.error(message, detail),
  } = options

  let pruneInFlight = false

  // Logging must not become the thing that throws out of a timer callback.
  const safeLog = (message: string, detail?: unknown) => {
    try {
      logError(message, detail)
    } catch {
      // nothing left to report to
    }
  }

  const runPrune = async (): Promise<boolean> => {
    if (pruneInFlight) return false
    pruneInFlight = true
    try {
      // prune() is called synchronously here, before the first await, so a
      // timer tick issues the call immediately rather than a microtask later.
      const { error } = await prune()
      if (error) safeLog(`${LOG_PREFIX} failed to prune tokens`, error.message)
    } catch (err) {
      safeLog(`${LOG_PREFIX} token prune threw`, err instanceof Error ? err.message : err)
    } finally {
      pruneInFlight = false
    }
    return true
  }

  const sweepTimer = setInterval(() => {
    try {
      sweepAuthCodes()
    } catch (err) {
      safeLog(`${LOG_PREFIX} auth-code sweep threw`, err instanceof Error ? err.message : err)
    }
  }, sweepIntervalMs)

  // The first prune runs shortly after boot rather than a full interval later:
  // a service redeployed or restarted more often than the interval would
  // otherwise never prune at all. The delay keeps it clear of boot work.
  const firstPruneTimer = setTimeout(() => {
    void runPrune()
  }, firstPruneDelayMs)

  const pruneTimer = setInterval(() => {
    void runPrune()
  }, pruneIntervalMs)

  sweepTimer.unref()
  pruneTimer.unref()
  firstPruneTimer.unref()

  return {
    runPrune,
    isPruneInFlight: () => pruneInFlight,
    stop: () => {
      clearInterval(sweepTimer)
      clearInterval(pruneTimer)
      clearTimeout(firstPruneTimer)
    },
    timers: { prune: pruneTimer, sweep: sweepTimer, firstPrune: firstPruneTimer },
  }
}
