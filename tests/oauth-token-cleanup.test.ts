/**
 * Unit tests — src/lib/oauth-token-cleanup.ts and its wiring in src/routes/oauth.ts (#286)
 *
 * Covers AC-FN-9 (the token prune never overlaps itself), AC-FN-10 (the
 * single-flight guard releases on failure; failures are logged, never
 * thrown), AC-FN-11 (the in-memory auth-code sweep keeps its own cadence,
 * independent of the prune) and AC-FN-12 (the timers do not hold the process
 * open).
 *
 * Intervals are driven with node:test mock timers and read from the named
 * constants (OAUTH_TOKEN_PRUNE_INTERVAL_MS, AUTH_CODE_SWEEP_INTERVAL_MS); no
 * interval value is pinned here. Ticks advance one interval at a time with a
 * microtask flush in between, so a guard that released too early would get
 * every chance to issue an overlapping prune.
 *
 * Measured caveat: mock-timer handles accept unref() but do not record it
 * (hasRef() stays true), so AC-FN-12 is checked with real timers — both via
 * the handles and by a child process that must exit on its own.
 *
 * No network, no .env.local: the route-wiring test sets placeholder env
 * values (an unresolvable `.invalid` host) and replaces globalThis.fetch
 * before the route module loads.
 *
 * Run: npm run test:unit
 */

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AUTH_CODE_SWEEP_INTERVAL_MS,
  OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS,
  OAUTH_TOKEN_PRUNE_INTERVAL_MS,
  startOAuthTokenCleanup,
  type OAuthCleanupHandle,
  type OAuthCleanupOptions,
  type TokenPruneResult,
} from '../src/lib/oauth-token-cleanup.js'

/**
 * A delay no test advances to, used to keep the post-boot first prune out of
 * the way. Stays under setTimeout's 2^31-1 ms ceiling: above it, Node fires
 * the timer immediately instead of never.
 */
const UNREACHABLE_DELAY_MS = 2_000_000_000

/** How many prune intervals the "stuck prune" cases span. */
const STUCK_PRUNE_INTERVALS = 10

/** Let pending promise continuations run (setImmediate is left unmocked on purpose). */
async function flushAsyncWork(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Advance mock time by `intervals` whole prune intervals, flushing between each. */
async function advancePruneIntervals(t: TestContext, intervals: number): Promise<void> {
  for (let step = 0; step < intervals; step++) {
    t.mock.timers.tick(OAUTH_TOKEN_PRUNE_INTERVAL_MS)
    await flushAsyncWork()
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface PruneScript {
  prune: OAuthCleanupOptions['prune']
  callCount: () => number
}

/** A prune whose Nth call runs `outcomes[N]` (the last outcome repeats). */
function scriptedPrune(...outcomes: Array<() => PromiseLike<TokenPruneResult>>): PruneScript {
  let calls = 0
  return {
    prune: () => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]
      calls++
      return outcome()
    },
    callCount: () => calls,
  }
}

const neverSettles = () => new Promise<TokenPruneResult>(() => {})
const succeeds = () => Promise.resolve<TokenPruneResult>({ error: null })

interface LogCapture {
  logError: NonNullable<OAuthCleanupOptions['logError']>
  entries: Array<{ message: string; detail: unknown }>
}

function captureLog(): LogCapture {
  const entries: LogCapture['entries'] = []
  return { entries, logError: (message, detail) => entries.push({ message, detail }) }
}

/**
 * Start cleanup under mock timers with the module's default intervals, and
 * fail the test if anything escapes as an unhandled rejection or uncaught
 * exception while it runs.
 *
 * The post-boot first prune is pushed out of reach by default so the cases
 * below observe the interval alone; the cadence tests pass the real
 * OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS to exercise it.
 */
function startUnderMockTimers(
  t: TestContext,
  options: Pick<OAuthCleanupOptions, 'prune'> & Partial<OAuthCleanupOptions>,
): OAuthCleanupHandle {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const escaped: unknown[] = []
  const onEscape = (reason: unknown) => escaped.push(reason)
  process.on('unhandledRejection', onEscape)
  process.on('uncaughtException', onEscape)

  const handle = startOAuthTokenCleanup({
    sweepAuthCodes: () => {},
    logError: () => {},
    firstPruneDelayMs: UNREACHABLE_DELAY_MS,
    ...options,
  })

  t.after(async () => {
    handle.stop()
    await flushAsyncWork()
    process.off('unhandledRejection', onEscape)
    process.off('uncaughtException', onEscape)
    assert.deepEqual(escaped, [], 'a prune or sweep failure escaped the timer')
  })
  return handle
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

test('cadence: the first prune runs OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS after start, not at start', async (t) => {
  const script = scriptedPrune(succeeds)
  startUnderMockTimers(t, { prune: script.prune, firstPruneDelayMs: OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS })

  await flushAsyncWork()
  assert.equal(script.callCount(), 0)

  t.mock.timers.tick(OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS - 1)
  await flushAsyncWork()
  assert.equal(script.callCount(), 0, 'pruned before the first-run delay elapsed')

  t.mock.timers.tick(1)
  await flushAsyncWork()
  assert.equal(script.callCount(), 1, 'a restart more frequent than the interval must still prune')

  // The interval takes over from there, measured from start.
  t.mock.timers.tick(OAUTH_TOKEN_PRUNE_INTERVAL_MS - OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS)
  await flushAsyncWork()
  assert.equal(script.callCount(), 2)
})

test('cadence: the first-run delay is shorter than the interval, or it would never help', () => {
  assert.ok(OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS > 0)
  assert.ok(OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS < OAUTH_TOKEN_PRUNE_INTERVAL_MS)
})

test('cadence: a prune that settles promptly runs once per interval', async (t) => {
  const script = scriptedPrune(succeeds)
  startUnderMockTimers(t, { prune: script.prune })

  await advancePruneIntervals(t, 3)
  assert.equal(script.callCount(), 3)
})

// ---------------------------------------------------------------------------
// AC-FN-9: single-flight under a stuck prune
// ---------------------------------------------------------------------------

test('single-flight: a prune that never settles is issued exactly once across many intervals', async (t) => {
  const script = scriptedPrune(neverSettles)
  const handle = startUnderMockTimers(t, { prune: script.prune })

  await advancePruneIntervals(t, STUCK_PRUNE_INTERVALS)

  assert.equal(script.callCount(), 1)
  assert.equal(handle.isPruneInFlight(), true)
})

test('single-flight: the guard holds when all the stuck intervals elapse in one jump', async (t) => {
  // No microtask turn between firings, so the guard must be taken
  // synchronously when a tick starts a prune.
  const script = scriptedPrune(neverSettles)
  startUnderMockTimers(t, { prune: script.prune })

  t.mock.timers.tick(OAUTH_TOKEN_PRUNE_INTERVAL_MS * STUCK_PRUNE_INTERVALS)
  await flushAsyncWork()

  assert.equal(script.callCount(), 1)
})

test('single-flight: runPrune while a prune is pending returns false without calling prune', async (t) => {
  const script = scriptedPrune(neverSettles)
  const handle = startUnderMockTimers(t, { prune: script.prune })

  await advancePruneIntervals(t, 1)
  assert.equal(script.callCount(), 1)

  assert.equal(await handle.runPrune(), false)
  assert.equal(script.callCount(), 1)
})

test('single-flight: once a long-pending prune resolves, the next tick prunes again', async (t) => {
  const stuck = deferred<TokenPruneResult>()
  const script = scriptedPrune(() => stuck.promise, succeeds)
  const handle = startUnderMockTimers(t, { prune: script.prune })

  await advancePruneIntervals(t, STUCK_PRUNE_INTERVALS)
  assert.equal(script.callCount(), 1)

  stuck.resolve({ error: null })
  await flushAsyncWork()
  assert.equal(handle.isPruneInFlight(), false)
  // Resolution alone must not trigger a catch-up prune; only the timer does.
  assert.equal(script.callCount(), 1)

  await advancePruneIntervals(t, 1)
  assert.equal(script.callCount(), 2)
})

// ---------------------------------------------------------------------------
// AC-FN-10: the guard releases on failure; failures are logged, not thrown
// ---------------------------------------------------------------------------

test('release on rejection: after a prune rejects, the next tick issues a new prune and the rejection is logged', async (t) => {
  const rejection = new Error('statement timeout on prune')
  const log = captureLog()
  const script = scriptedPrune(() => Promise.reject(rejection), succeeds)
  const handle = startUnderMockTimers(t, { prune: script.prune, logError: log.logError })

  await advancePruneIntervals(t, 1)
  assert.equal(script.callCount(), 1)
  assert.equal(handle.isPruneInFlight(), false, 'the guard was not released after a rejection')
  assert.equal(log.entries.length, 1)
  assert.equal(log.entries[0].detail, rejection.message)

  await advancePruneIntervals(t, 1)
  assert.equal(script.callCount(), 2)
})

test('release on rejection: a prune that stays pending across intervals and then rejects frees the next tick', async (t) => {
  const stuck = deferred<TokenPruneResult>()
  const log = captureLog()
  const script = scriptedPrune(() => stuck.promise, succeeds)
  startUnderMockTimers(t, { prune: script.prune, logError: log.logError })

  await advancePruneIntervals(t, STUCK_PRUNE_INTERVALS)
  assert.equal(script.callCount(), 1)

  stuck.reject(new Error('connection terminated'))
  await flushAsyncWork()
  assert.equal(log.entries.length, 1)

  await advancePruneIntervals(t, 1)
  assert.equal(script.callCount(), 2)
})

test('release on rejection: repeated rejections keep pruning every interval and are each logged', async (t) => {
  const log = captureLog()
  const script = scriptedPrune(() => Promise.reject(new Error('still down')))
  startUnderMockTimers(t, { prune: script.prune, logError: log.logError })

  await advancePruneIntervals(t, 4)
  assert.equal(script.callCount(), 4)
  assert.equal(log.entries.length, 4)
})

test('release on rejection: a non-Error rejection reason is logged and released too', async (t) => {
  const log = captureLog()
  const script = scriptedPrune(() => Promise.reject('plain string reason'), succeeds)
  startUnderMockTimers(t, { prune: script.prune, logError: log.logError })

  await advancePruneIntervals(t, 2)
  assert.equal(script.callCount(), 2)
  assert.equal(log.entries.length, 1)
  assert.equal(log.entries[0].detail, 'plain string reason')
})

test('release on in-band error: a prune resolving with { error } is logged and the next tick prunes again', async (t) => {
  const log = captureLog()
  const script = scriptedPrune(() => Promise.resolve({ error: { message: 'canceling statement due to statement timeout' } }), succeeds)
  startUnderMockTimers(t, { prune: script.prune, logError: log.logError })

  await advancePruneIntervals(t, 1)
  assert.equal(log.entries.length, 1)
  assert.equal(log.entries[0].detail, 'canceling statement due to statement timeout')

  await advancePruneIntervals(t, 1)
  assert.equal(script.callCount(), 2)
})

test('release on synchronous throw: a prune that throws before returning a promise is logged and released', async (t) => {
  const log = captureLog()
  let calls = 0
  const prune: OAuthCleanupOptions['prune'] = () => {
    calls++
    if (calls === 1) throw new Error('query builder threw')
    return Promise.resolve({ error: null })
  }
  const handle = startUnderMockTimers(t, { prune, logError: log.logError })

  await advancePruneIntervals(t, 1)
  assert.equal(handle.isPruneInFlight(), false)
  assert.equal(log.entries.length, 1)

  await advancePruneIntervals(t, 1)
  assert.equal(calls, 2)
})

test('release on failure: runPrune never rejects, and reports that it ran', async (t) => {
  const script = scriptedPrune(() => Promise.reject(new Error('down')))
  const handle = startUnderMockTimers(t, { prune: script.prune })

  assert.equal(await handle.runPrune(), true)
  assert.equal(handle.isPruneInFlight(), false)
})

test('release on failure: a logger that itself throws neither escapes the timer nor wedges the guard', async (t) => {
  let logCalls = 0
  const script = scriptedPrune(() => Promise.reject(new Error('down')))
  const handle = startUnderMockTimers(t, {
    prune: script.prune,
    logError: () => {
      logCalls++
      throw new Error('log sink unavailable')
    },
  })

  await advancePruneIntervals(t, 3)
  assert.equal(script.callCount(), 3)
  assert.equal(logCalls, 3)
  assert.equal(handle.isPruneInFlight(), false)
})

test('release on failure: with no logError supplied, the failure goes to console.error', async (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  const script = scriptedPrune(() => Promise.reject(new Error('down')), succeeds)
  // Bypass the helper's silent default logger to exercise the module default.
  t.mock.timers.enable({ apis: ['setInterval'] })
  const handle = startOAuthTokenCleanup({ prune: script.prune, sweepAuthCodes: () => {} })
  t.after(() => handle.stop())

  await advancePruneIntervals(t, 2)
  assert.equal(consoleError.mock.callCount(), 1)
  assert.equal(script.callCount(), 2)
})

// ---------------------------------------------------------------------------
// AC-FN-11: the auth-code sweep keeps its own cadence
// ---------------------------------------------------------------------------

test('sweep independence: the sweep runs every AUTH_CODE_SWEEP_INTERVAL_MS while the prune is stuck', async (t) => {
  let sweeps = 0
  const script = scriptedPrune(neverSettles)
  startUnderMockTimers(t, { prune: script.prune, sweepAuthCodes: () => sweeps++ })

  // Span several prune intervals, stepping by the sweep interval so each
  // sweep firing is observed on its own.
  const sweepSteps = Math.ceil((OAUTH_TOKEN_PRUNE_INTERVAL_MS * 3) / AUTH_CODE_SWEEP_INTERVAL_MS)
  for (let step = 1; step <= sweepSteps; step++) {
    t.mock.timers.tick(AUTH_CODE_SWEEP_INTERVAL_MS)
    await flushAsyncWork()
    assert.equal(sweeps, step, `sweep missed at step ${step}`)
  }
  assert.equal(script.callCount(), 1, 'the stuck prune should still be the only one issued')
})

test('sweep independence: sweep and prune counts each follow their own named interval', async (t) => {
  let sweeps = 0
  const script = scriptedPrune(succeeds)
  startUnderMockTimers(t, { prune: script.prune, sweepAuthCodes: () => sweeps++ })

  await advancePruneIntervals(t, 2)
  const elapsedMs = OAUTH_TOKEN_PRUNE_INTERVAL_MS * 2
  assert.equal(sweeps, Math.floor(elapsedMs / AUTH_CODE_SWEEP_INTERVAL_MS))
  assert.equal(script.callCount(), 2)
})

test('sweep independence: a throwing sweep is logged, keeps its cadence, and does not disturb the prune', async (t) => {
  let sweeps = 0
  const log = captureLog()
  const script = scriptedPrune(succeeds)
  startUnderMockTimers(t, {
    prune: script.prune,
    logError: log.logError,
    sweepAuthCodes: () => {
      sweeps++
      throw new Error('sweep blew up')
    },
  })

  t.mock.timers.tick(AUTH_CODE_SWEEP_INTERVAL_MS)
  await flushAsyncWork()
  t.mock.timers.tick(AUTH_CODE_SWEEP_INTERVAL_MS)
  await flushAsyncWork()
  assert.equal(sweeps, 2)
  assert.equal(log.entries.length, 2)

  const beforePrune = script.callCount()
  await advancePruneIntervals(t, 1)
  assert.equal(script.callCount(), beforePrune + 1)
})

test('stop(): clears both timers', async (t) => {
  let sweeps = 0
  const script = scriptedPrune(succeeds)
  const handle = startUnderMockTimers(t, { prune: script.prune, sweepAuthCodes: () => sweeps++ })

  handle.stop()
  await advancePruneIntervals(t, 2)
  assert.equal(script.callCount(), 0)
  assert.equal(sweeps, 0)
})

// ---------------------------------------------------------------------------
// AC-FN-12: the timers do not hold the process open
// ---------------------------------------------------------------------------

test('unref: both real timer handles report hasRef() === false', () => {
  const handle = startOAuthTokenCleanup({ prune: neverSettles, sweepAuthCodes: () => {} })
  try {
    assert.equal(handle.timers.prune.hasRef(), false, 'prune timer keeps the process alive')
    assert.equal(handle.timers.sweep.hasRef(), false, 'sweep timer keeps the process alive')
  } finally {
    handle.stop()
  }
})

test('unref: a process whose only work is the cleanup timers (with a stuck prune) exits on its own', () => {
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/lib/oauth-token-cleanup.ts', import.meta.url))).href
  const script = [
    `const { startOAuthTokenCleanup } = await import(${JSON.stringify(moduleUrl)});`,
    'startOAuthTokenCleanup({ prune: () => new Promise(() => {}), sweepAuthCodes: () => {} });',
    "console.log('started');",
  ].join('\n')

  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 20_000,
  })

  assert.equal(child.error, undefined, `child did not exit on its own: ${child.error?.message}`)
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /started/)
})

// ---------------------------------------------------------------------------
// Wiring: the real route module schedules a single-flight prune on the named cadence
// ---------------------------------------------------------------------------

test('route wiring: src/routes/oauth.ts issues one refresh-token DELETE per interval and none while it is stuck', async (t) => {
  // Every request the route module's shared client makes lands here and
  // never gets a response, i.e. a database that has stopped answering.
  const requests: Array<{ url: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input instanceof Request ? input.url : input), method: init?.method ?? 'GET' })
    return new Promise<Response>(() => {})
  })
  t.mock.timers.enable({ apis: ['setInterval'] })

  process.env.SUPA_PROJECT_URL = 'https://oauth-cleanup-test.invalid'
  process.env.SUPA_SERVICE_ROLE = 'placeholder-service-role'
  process.env.JWT_SECRET = 'placeholder-jwt-secret-for-unit-tests-only'
  process.env.OAUTH_CLIENT_SECRET = 'placeholder-client-secret'
  await import('../src/routes/oauth.js')

  const pruneRequests = () =>
    requests.filter((request) => request.method === 'DELETE' && request.url.includes('/oauth_refresh_tokens'))

  t.mock.timers.tick(OAUTH_TOKEN_PRUNE_INTERVAL_MS - 1)
  await flushAsyncWork()
  assert.equal(pruneRequests().length, 0, 'pruned before a full interval elapsed')

  t.mock.timers.tick(1)
  const deadline = Date.now() + 2_000
  while (pruneRequests().length === 0 && Date.now() < deadline) await flushAsyncWork()
  assert.equal(pruneRequests().length, 1, 'the route did not prune after one interval')

  await advancePruneIntervals(t, STUCK_PRUNE_INTERVALS)
  assert.equal(pruneRequests().length, 1, 'the route stacked prune statements on a database that is not answering')
})
