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
