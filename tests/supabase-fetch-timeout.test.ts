/**
 * Unit tests — src/lib/bounded-fetch.ts and its wiring into src/lib/supabase.ts (#286)
 *
 * Covers AC-FN-7 (shared-client calls are time-bounded) and AC-FN-8 (normal
 * calls pass through unchanged; a caller-supplied abort signal is combined
 * with the timeout, not replaced).
 *
 * No network: every "underlying fetch" is an in-process stub, and the shared
 * client test replaces globalThis.fetch before the client is loaded. No
 * .env.local: the shared-client test sets placeholder env values (an
 * unresolvable `.invalid` host) before importing the module, so nothing it
 * loads can reach a real project even if the stub were bypassed.
 *
 * Timing notes (measured, not assumed):
 *   - node:test mock timers do NOT drive AbortSignal.timeout, so the timeout
 *     mechanism is exercised with a short real timeout passed explicitly.
 *   - The named ceiling, SUPABASE_FETCH_TIMEOUT_MS, is far too long to wait
 *     out, so the shared-client test intercepts AbortSignal.timeout, asserts
 *     the value it was asked for is the named constant, and fires that signal
 *     itself. The value of the constant is never pinned here.
 *
 * Run: npm run test:unit
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { createBoundedFetch, SUPABASE_FETCH_TIMEOUT_MS } from '../src/lib/bounded-fetch.js'

/** Short real timeout for mechanism tests — deliberately unrelated to the named constant. */
const MECHANISM_TIMEOUT_MS = 100
/** Slack for a real timer on a loaded CI box; generous, since the failure mode under test is "never". */
const TIMER_TOLERANCE_MS = 2_000
/** Unresolvable host (RFC 6761 `.invalid`): a leaked request cannot reach anything. */
const PLACEHOLDER_SUPABASE_URL = 'https://bounded-fetch-test.invalid'

interface RecordedCall {
  input: RequestInfo | URL
  init: RequestInit | undefined
  signal: AbortSignal | undefined
}

/**
 * A fetch that never resolves on its own, but — like Node's real fetch —
 * rejects with the signal's reason once the signal it was given aborts.
 * An unaborted call stays pending forever.
 */
function neverResolvingFetch(calls: RecordedCall[]): typeof fetch {
  return (input, init) => {
    const signal = init?.signal ?? undefined
    calls.push({ input, init, signal })
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) return
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
}

/** Resolves true if `promise` is still pending after the event loop has turned. */
async function isStillPending(promise: Promise<unknown>): Promise<boolean> {
  const pendingMarker = Symbol('pending')
  const winner = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((resolve) => setImmediate(() => resolve(pendingMarker))),
  ])
  return winner === pendingMarker
}

/**
 * Fail with a diagnosis instead of hanging: the property under test is that a
 * call does not stay open, so an assertion on it must not be able to either.
 */
async function settleWithin<T>(promise: Promise<T>, deadlineMs: number, label: string): Promise<T> {
  let guardTimer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    guardTimer = setTimeout(
      () => reject(new Error(`${label}: still pending after ${deadlineMs}ms, so the call is unbounded`)),
      deadlineMs,
    )
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    clearTimeout(guardTimer)
  }
}

/** Deadline for a call that should end at the mechanism timeout. */
const MECHANISM_DEADLINE_MS = MECHANISM_TIMEOUT_MS + TIMER_TOLERANCE_MS

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + TIMER_TOLERANCE_MS
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

// ---------------------------------------------------------------------------
// AC-FN-7: the timeout mechanism
// ---------------------------------------------------------------------------

test('bounded fetch: a never-resolving fetch rejects with TimeoutError once the timeout elapses', async () => {
  const calls: RecordedCall[] = []
  const boundedFetch = createBoundedFetch(MECHANISM_TIMEOUT_MS, neverResolvingFetch(calls))

  const startedAt = performance.now()
  const pending = boundedFetch('https://bounded-fetch-test.invalid/rest/v1/probe')
  await assert.rejects(settleWithin(pending, MECHANISM_DEADLINE_MS, 'never-resolving fetch'), (err: unknown) => {
    assert.ok(err instanceof DOMException, `expected a DOMException, got ${String(err)}`)
    assert.equal(err.name, 'TimeoutError')
    return true
  })
  const elapsedMs = performance.now() - startedAt

  // Not early: the wrapper waited for its own timeout rather than failing fast
  // for some unrelated reason. 0.8x absorbs clock-source skew between
  // performance.now() and libuv's timer clock.
  assert.ok(elapsedMs >= MECHANISM_TIMEOUT_MS * 0.8, `rejected after ${elapsedMs}ms, before the timeout`)
  assert.ok(elapsedMs < MECHANISM_TIMEOUT_MS + TIMER_TOLERANCE_MS, `took ${elapsedMs}ms`)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal?.aborted, true)
})

test('bounded fetch: every call gets its own timeout, started at call time, not at wrapper creation', async () => {
  const calls: RecordedCall[] = []
  const boundedFetch = createBoundedFetch(MECHANISM_TIMEOUT_MS, neverResolvingFetch(calls))

  // Outlive the timeout before the first call. A wrapper that created one
  // signal when it was built (or reused one across calls) would hand this
  // call an already-aborted signal.
  await new Promise((resolve) => setTimeout(resolve, MECHANISM_TIMEOUT_MS * 2))

  const first = boundedFetch('https://bounded-fetch-test.invalid/a')
  first.catch(() => {})
  assert.equal(calls[0].signal?.aborted, false, 'a fresh call must not start out aborted')

  await assert.rejects(settleWithin(first, MECHANISM_DEADLINE_MS, 'first call'), { name: 'TimeoutError' })

  const second = boundedFetch('https://bounded-fetch-test.invalid/b')
  second.catch(() => {})
  assert.equal(calls[1].signal?.aborted, false, 'the timeout from the first call leaked into the second')
  assert.notEqual(calls[1].signal, calls[0].signal)
  await assert.rejects(settleWithin(second, MECHANISM_DEADLINE_MS, 'second call'), { name: 'TimeoutError' })
})

test('bounded fetch: with no argument, the timeout is SUPABASE_FETCH_TIMEOUT_MS', async (t) => {
  const requestedTimeouts: number[] = []
  const realTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    requestedTimeouts.push(ms)
    return realTimeout(ms)
  })
  const okResponse = new Response('ok')
  const boundedFetch = createBoundedFetch(undefined, async () => okResponse)

  await boundedFetch('https://bounded-fetch-test.invalid/default')

  assert.deepEqual(requestedTimeouts, [SUPABASE_FETCH_TIMEOUT_MS])
})

test('bounded fetch: with no base fetch, resolves globalThis.fetch at call time, not at creation', async (t) => {
  const boundedFetch = createBoundedFetch(MECHANISM_TIMEOUT_MS)
  const installedLater = new Response('installed after the wrapper was built')
  t.mock.method(globalThis, 'fetch', async () => installedLater)

  const response = await boundedFetch('https://bounded-fetch-test.invalid/late')
  assert.equal(response, installedLater)
})

// ---------------------------------------------------------------------------
// AC-FN-7: through the exported shared client (src/lib/supabase.ts)
// ---------------------------------------------------------------------------

test('shared client: a query that never gets a response fails in-band once the SUPABASE_FETCH_TIMEOUT_MS signal fires', async (t) => {
  // Fire the named timeout ourselves instead of waiting it out, and record
  // which duration the client's fetch path asked for.
  const timeoutRequests: Array<{ ms: number; controller: AbortController }> = []
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    const controller = new AbortController()
    timeoutRequests.push({ ms, controller })
    return controller.signal
  })
  const calls: RecordedCall[] = []
  // Installed before the client module loads, so the shared client can only
  // ever reach this stub (with or without the bounded wrapper in between).
  t.mock.method(globalThis, 'fetch', neverResolvingFetch(calls))

  process.env.SUPA_PROJECT_URL = PLACEHOLDER_SUPABASE_URL
  process.env.SUPA_SERVICE_ROLE = 'placeholder-service-role'
  const { supabase } = await import('../src/lib/supabase.js')

  const queryResult = Promise.resolve(supabase.from('bounded_fetch_probe').select('*'))
  await waitUntil(() => calls.length === 1, 'the shared client to issue its request')

  assert.ok(String(calls[0].input).startsWith(PLACEHOLDER_SUPABASE_URL))
  const namedTimeouts = timeoutRequests.filter((entry) => entry.ms === SUPABASE_FETCH_TIMEOUT_MS)
  assert.equal(namedTimeouts.length, 1, 'the shared client did not bound its request with SUPABASE_FETCH_TIMEOUT_MS')

  // Before the timeout fires, the query is genuinely stuck — this is the
  // unbounded behaviour the wrapper exists to end.
  assert.equal(await isStillPending(queryResult), true)
  assert.equal(calls[0].signal?.aborted, false)

  namedTimeouts[0].controller.abort(new DOMException('signal timed out', 'TimeoutError'))

  const { data, error } = await settleWithin(queryResult, TIMER_TOLERANCE_MS, 'shared-client query after its timeout fired')
  assert.equal(calls[0].signal?.aborted, true)
  assert.equal(data, null)
  assert.ok(error, 'expected the timeout to surface as an in-band error')
  assert.match(error.message, /TimeoutError/)
})

test('supabase-js client built on createBoundedFetch: a never-resolving request resolves to an in-band error within the timeout', async () => {
  // Real timer end to end through supabase-js, using a short explicit timeout
  // in place of the named constant (whose wiring is asserted above).
  const calls: RecordedCall[] = []
  const client = createClient(PLACEHOLDER_SUPABASE_URL, 'placeholder-service-role', {
    global: { fetch: createBoundedFetch(MECHANISM_TIMEOUT_MS, neverResolvingFetch(calls)) },
  })

  const startedAt = performance.now()
  const { data, error } = await settleWithin(
    Promise.resolve(client.from('bounded_fetch_probe').select('*')),
    MECHANISM_DEADLINE_MS,
    'supabase-js query',
  )
  const elapsedMs = performance.now() - startedAt

  assert.equal(calls.length, 1)
  assert.equal(data, null)
  assert.ok(error)
  assert.match(error.message, /TimeoutError/)
  assert.ok(elapsedMs < MECHANISM_TIMEOUT_MS + TIMER_TOLERANCE_MS, `took ${elapsedMs}ms`)
})

// ---------------------------------------------------------------------------
// AC-FN-8: pass-through of normal calls
// ---------------------------------------------------------------------------

test('bounded fetch: a resolved response is returned as the identical object, with input and init fields forwarded', async () => {
  const response = new Response('{"rows":[]}', { status: 207, headers: { 'x-probe': 'kept' } })
  const calls: RecordedCall[] = []
  const baseFetch: typeof fetch = async (input, init) => {
    calls.push({ input, init, signal: init?.signal ?? undefined })
    return response
  }
  const boundedFetch = createBoundedFetch(MECHANISM_TIMEOUT_MS, baseFetch)
  const requestUrl = new URL('https://bounded-fetch-test.invalid/rest/v1/probe?select=*')
  const headers = { apikey: 'placeholder', 'content-type': 'application/json' }

  const returned = await boundedFetch(requestUrl, { method: 'PATCH', headers, body: '{"a":1}', cache: 'no-store' })

  assert.equal(returned, response, 'the response object must pass through untouched')
  assert.equal(returned.status, 207)
  assert.equal(returned.headers.get('x-probe'), 'kept')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input, requestUrl, 'input must be forwarded as-is')
  assert.equal(calls[0].init?.method, 'PATCH')
  assert.equal(calls[0].init?.headers, headers)
  assert.equal(calls[0].init?.body, '{"a":1}')
  assert.equal(calls[0].init?.cache, 'no-store')
  assert.ok(calls[0].signal instanceof AbortSignal, 'the underlying fetch must always receive a signal')
  assert.equal(calls[0].signal.aborted, false)
})

test('bounded fetch: with no init at all, the underlying fetch still receives a live timeout signal', async () => {
  const calls: RecordedCall[] = []
  const boundedFetch = createBoundedFetch(MECHANISM_TIMEOUT_MS, async (input, init) => {
    calls.push({ input, init, signal: init?.signal ?? undefined })
    return new Response(null, { status: 204 })
  })

  await boundedFetch('https://bounded-fetch-test.invalid/no-init')
  assert.ok(calls[0].signal)
  assert.equal(calls[0].signal.aborted, false)
  await waitUntil(() => calls[0].signal?.aborted === true, 'the timeout signal to fire')
  assert.equal((calls[0].signal.reason as DOMException).name, 'TimeoutError')
})

test('bounded fetch: a rejection from the underlying fetch passes through as the identical error', async () => {
  const networkFailure = new TypeError('fetch failed')
  const boundedFetch = createBoundedFetch(MECHANISM_TIMEOUT_MS, async () => {
    throw networkFailure
  })

  await assert.rejects(boundedFetch('https://bounded-fetch-test.invalid/down'), (err: unknown) => {
    assert.equal(err, networkFailure)
    return true
  })
})

// ---------------------------------------------------------------------------
// AC-FN-8: a caller-supplied signal is combined with the timeout, not replaced
// ---------------------------------------------------------------------------

test('caller signal on init: aborting it cancels the call before the timeout, with the caller\'s reason', async () => {
  const calls: RecordedCall[] = []
  // A long mechanism timeout so only the caller can be responsible.
  const boundedFetch = createBoundedFetch(MECHANISM_TIMEOUT_MS * 50, neverResolvingFetch(calls))
  const caller = new AbortController()
  const callerReason = new Error('caller cancelled')

  const pending = boundedFetch('https://bounded-fetch-test.invalid/cancel', { signal: caller.signal })
  pending.catch(() => {})
  assert.equal(await isStillPending(pending), true)

  const startedAt = performance.now()
  caller.abort(callerReason)
  await assert.rejects(settleWithin(pending, TIMER_TOLERANCE_MS, 'caller-aborted call'), (err: unknown) => {
    assert.equal(err, callerReason)
    return true
  })
  assert.ok(performance.now() - startedAt < MECHANISM_TIMEOUT_MS * 50, 'caller abort did not take effect early')
  assert.notEqual(calls[0].signal, caller.signal, 'the caller signal was passed through raw, so no timeout applies')
})

test('caller signal on init: the timeout still fires when the caller never aborts', async () => {
  const calls: RecordedCall[] = []
  const boundedFetch = createBoundedFetch(MECHANISM_TIMEOUT_MS, neverResolvingFetch(calls))
  const caller = new AbortController()

  await assert.rejects(
    settleWithin(
      boundedFetch('https://bounded-fetch-test.invalid/slow', { signal: caller.signal }),
      MECHANISM_DEADLINE_MS,
      'call with an idle caller signal',
    ),
    { name: 'TimeoutError' },
  )
  assert.equal(caller.signal.aborted, false, 'the timeout must not abort the caller\'s own controller')
})

test('caller signal on a Request input: honoured when init carries no signal', async () => {
  const calls: RecordedCall[] = []
  const boundedFetch = createBoundedFetch(MECHANISM_TIMEOUT_MS * 50, neverResolvingFetch(calls))
  const caller = new AbortController()
  const request = new Request('https://bounded-fetch-test.invalid/request-input', { signal: caller.signal })

  const pending = boundedFetch(request)
  pending.catch(() => {})
  assert.equal(calls[0].input, request)
  assert.equal(calls[0].signal?.aborted, false)

  const callerReason = new Error('request owner cancelled')
  caller.abort(callerReason)
  await assert.rejects(settleWithin(pending, TIMER_TOLERANCE_MS, 'Request-signal abort'), (err: unknown) => {
    assert.equal(err, callerReason)
    return true
  })
})

test('caller signal on a Request input: the timeout still applies', async () => {
  const calls: RecordedCall[] = []
  const boundedFetch = createBoundedFetch(MECHANISM_TIMEOUT_MS, neverResolvingFetch(calls))
  const request = new Request('https://bounded-fetch-test.invalid/request-timeout', {
    signal: new AbortController().signal,
  })

  await assert.rejects(settleWithin(boundedFetch(request), MECHANISM_DEADLINE_MS, 'Request input'), { name: 'TimeoutError' })
})

test('caller signal already aborted: the underlying fetch receives an aborted signal and no request proceeds', async () => {
  const calls: RecordedCall[] = []
  const boundedFetch = createBoundedFetch(MECHANISM_TIMEOUT_MS * 50, neverResolvingFetch(calls))
  const callerReason = new Error('aborted before the call')

  await assert.rejects(
    settleWithin(
      boundedFetch('https://bounded-fetch-test.invalid/pre-aborted', { signal: AbortSignal.abort(callerReason) }),
      TIMER_TOLERANCE_MS,
      'pre-aborted call',
    ),
    (err: unknown) => {
      assert.equal(err, callerReason)
      return true
    },
  )
  assert.equal(calls[0].signal?.aborted, true)
})

test('caller signal via supabase-js .abortSignal(): a tighter caller bound wins over the client-wide timeout', async () => {
  // The profile read passes its own, tighter AbortSignal.timeout through
  // .abortSignal(); this is the path that has to survive the wrapper.
  const calls: RecordedCall[] = []
  const client = createClient(PLACEHOLDER_SUPABASE_URL, 'placeholder-service-role', {
    global: { fetch: createBoundedFetch(MECHANISM_TIMEOUT_MS * 50, neverResolvingFetch(calls)) },
  })
  const caller = new AbortController()

  const queryResult = Promise.resolve(client.from('bounded_fetch_probe').select('*').abortSignal(caller.signal))
  await waitUntil(() => calls.length === 1, 'the request to be issued')
  assert.equal(await isStillPending(queryResult), true)

  caller.abort(new DOMException('caller bound reached', 'AbortError'))
  const { error } = await settleWithin(queryResult, TIMER_TOLERANCE_MS, 'query after caller abort')
  assert.ok(error)
  assert.match(error.message, /AbortError/)
  assert.equal(calls[0].signal?.aborted, true)
})
