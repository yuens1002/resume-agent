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
 * removing a row up to an hour after it becomes eligible is immaterial, and it
 * issues a sixtieth of the statements the previous per-minute prune did.
 */
export const OAUTH_TOKEN_PRUNE_INTERVAL_MS = 60 * 60 * 1000

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
  /** Clears both timers. */
  stop: () => void
  /** Exposed so callers and tests can confirm both timers are unref'd. */
  timers: {
    prune: ReturnType<typeof setInterval>
    sweep: ReturnType<typeof setInterval>
  }
}

const LOG_PREFIX = '[oauth] cleanup:'

/**
 * Start the auth-code sweep and the single-flight token prune. Both timers are
 * unref'd, so they never keep the process alive on their own. The first prune
 * runs one interval after start, as before.
 */
export function startOAuthTokenCleanup(options: OAuthCleanupOptions): OAuthCleanupHandle {
  const {
    prune,
    sweepAuthCodes,
    pruneIntervalMs = OAUTH_TOKEN_PRUNE_INTERVAL_MS,
    sweepIntervalMs = AUTH_CODE_SWEEP_INTERVAL_MS,
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

  const pruneTimer = setInterval(() => {
    void runPrune()
  }, pruneIntervalMs)

  sweepTimer.unref()
  pruneTimer.unref()

  return {
    runPrune,
    isPruneInFlight: () => pruneInFlight,
    stop: () => {
      clearInterval(sweepTimer)
      clearInterval(pruneTimer)
    },
    timers: { prune: pruneTimer, sweep: sweepTimer },
  }
}
