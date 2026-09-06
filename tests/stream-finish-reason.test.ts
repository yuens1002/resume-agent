/**
 * Unit tests — the ai@4 streaming contract `queryProfileStream` depends on (#251).
 *
 * These pin an UPSTREAM assumption, not our own code, and that is the point.
 * `QueryProfileStreamResult.finishReason` is a synchronous getter fed by
 * `onFinish` rather than the SDK's own `result.finishReason` promise. That
 * looks like a gratuitous detour until you know why: the SDK promise never
 * settles when generation fails, so awaiting it hung the MCP tool handler until
 * the client timed out and dropped the observed_queries row on the HTTP path —
 * on exactly the two failures the field exists to make visible.
 *
 * Nothing in the repo would catch that returning, because a green run of every
 * other test only exercises the success path. If a future `ai` upgrade changes
 * any of this, these fail and the getter can be simplified deliberately instead
 * of by accident.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { streamText } from 'ai'
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test'
import { failClosedOnSwallowedError } from '../src/routes/query.js'

/** Resolves to `'settled'` if `promise` settles within `ms`, else `'pending'`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<'settled' | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const pending = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([promise.then(() => 'settled' as const, () => 'settled' as const), pending])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Drain a textStream, reporting whether it closed cleanly or threw. */
async function drain(stream: AsyncIterable<string>): Promise<{ text: string; threw: boolean }> {
  let text = ''
  try {
    for await (const chunk of stream) text += chunk
    return { text, threw: false }
  } catch {
    return { text, threw: true }
  }
}

const okModel = new MockLanguageModelV1({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-delta', textDelta: 'Hello' },
        { type: 'text-delta', textDelta: ' world' },
        { type: 'finish', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2 } },
      ],
    }),
    rawCall: { rawPrompt: null, rawSettings: {} },
  }),
})

const failingModel = new MockLanguageModelV1({
  doStream: async () => {
    throw new Error('simulated provider failure')
  },
})

describe('ai@4 streaming contract — why finishReason is captured via onFinish', () => {
  it('resolves finishReason and calls onFinish on a clean completion', async () => {
    let observed: string | undefined
    const result = streamText({
      model: okModel,
      prompt: 'hi',
      onFinish: ({ finishReason }) => {
        observed = finishReason
      },
    })

    const { text, threw } = await drain(result.textStream)
    assert.equal(text, 'Hello world')
    assert.equal(threw, false)
    assert.equal(observed, 'stop', 'onFinish must have run before the stream closed')
    assert.equal(await settlesWithin(result.finishReason, 250), 'settled', 'the SDK promise settles on success')
  })

  it('leaves the SDK finishReason promise FOREVER PENDING when the provider call fails', async () => {
    // The load-bearing case. `await result.finishReason` here is not slow, it
    // is permanent: the promise is resolved only from the event processor's
    // flush, which returns early when no step ever completed.
    let observed: string | undefined
    let sawError = false
    const result = streamText({
      model: failingModel,
      prompt: 'hi',
      onFinish: ({ finishReason }) => {
        observed = finishReason
      },
      onError: () => {
        sawError = true
      },
    })

    const { text, threw } = await drain(result.textStream)
    assert.equal(text, '', 'no text is produced')
    assert.equal(threw, false, 'the stream CLOSES NORMALLY rather than throwing — nothing signals failure here')
    assert.equal(sawError, true, 'onError is how a pre-first-step failure surfaces')
    assert.equal(observed, undefined, 'onFinish never runs, so our getter correctly reports "did not complete"')

    assert.equal(
      await settlesWithin(result.finishReason, 500),
      'pending',
      'awaiting the SDK promise on this path hangs the caller — this is why queryProfileStream does not',
    )
  })

  it('an absent finishReason is therefore a reliable "did not complete" signal', async () => {
    // The property the logging on both streaming surfaces relies on: a null
    // finish_reason in observed_queries means generation did not finish, and a
    // present one means it did. Asserted as the pair, since either half alone
    // would pass against a getter that always returned undefined.
    const capture = async (model: MockLanguageModelV1): Promise<string | undefined> => {
      let observed: string | undefined
      const result = streamText({
        model,
        prompt: 'hi',
        onFinish: ({ finishReason }) => {
          observed = finishReason
        },
        onError: () => {},
      })
      await drain(result.textStream)
      return observed
    }

    assert.equal(await capture(okModel), 'stop')
    assert.equal(await capture(failingModel), undefined)
  })
})

describe('failClosedOnSwallowedError — turning a silent close into a failure', () => {
  /** Pump a string through the transform, reporting text and whether it threw. */
  async function pump(
    chunks: string[],
    sawError: () => boolean,
    getError: () => unknown,
  ): Promise<{ text: string; threw: unknown | undefined }> {
    const source = new ReadableStream<string>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        controller.close()
      },
    })
    const reader = source.pipeThrough(failClosedOnSwallowedError(sawError, getError)).getReader()
    let text = ''
    for (;;) {
      try {
        const { done, value } = await reader.read()
        if (done) return { text, threw: undefined }
        text += value
      } catch (err) {
        return { text, threw: err }
      }
    }
  }

  it('passes every chunk through untouched when no error was reported', async () => {
    const { text, threw } = await pump(['a', 'b', 'c'], () => false, () => undefined)
    assert.equal(text, 'abc')
    assert.equal(threw, undefined, 'a clean stream must close cleanly')
  })

  it('errors at end of stream with the reported error when one was swallowed', async () => {
    const boom = new Error('simulated provider failure')
    const { text, threw } = await pump(['partial'], () => true, () => boom)
    // Whatever was produced still reaches the consumer — the MCP handler logs
    // exactly this as partial output before rethrowing.
    assert.equal(text, 'partial')
    assert.equal(threw, boom, 'the original error must propagate, not a substitute')
  })

  it('errors an empty stream — the pre-first-token case that looked like success', async () => {
    // The whole point: ai@4 hands us a normally-closed EMPTY stream on a
    // provider failure. Without this transform, HTTP returns a 200 with no body
    // and the MCP tool returns an empty success result.
    const boom = new Error('provider rejected before the first token')
    const { text, threw } = await pump([], () => true, () => boom)
    assert.equal(text, '')
    assert.equal(threw, boom)
  })

  it('reads the flags at flush time, not at construction', async () => {
    // onError sets them after the transform is built, so capturing values
    // instead of getters would silently never fire.
    let failed = false
    let error: unknown
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('x')
        // Simulate onError landing mid-stream, after construction.
        failed = true
        error = new Error('late')
        controller.close()
      },
    })
    const reader = source.pipeThrough(failClosedOnSwallowedError(() => failed, () => error)).getReader()
    assert.equal((await reader.read()).value, 'x')
    await assert.rejects(() => reader.read(), /late/)
  })
})
