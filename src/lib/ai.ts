import './env.js'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
if (!OPENROUTER_API_KEY) throw new Error('Missing OPENROUTER_API_KEY')

export const MODEL = process.env.AI_MODEL ?? 'anthropic/claude-haiku-4.5'

export const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: OPENROUTER_API_KEY,
})

export function getModel(modelOverride?: string): LanguageModel {
  return openrouter(modelOverride ?? MODEL)
}

/** Minimal shape `generateWithLengthRetry` needs from a `generateText` call — kept
 * loose (not the full AI SDK result type) so the helper is unit-testable with
 * plain stub functions instead of a live model call. */
export interface LengthRetryResult {
  text: string
  finishReason: string
  response: unknown
}

/**
 * Calls `callFn` once at `cap` maxTokens. If the model truncated the answer
 * (`finishReason === 'length'`), retries ONCE at `min(cap * 2, retryCeiling)`
 * maxTokens — same prompt/system/model, whatever `callFn` closes over — and
 * returns the retry's result regardless of its own finishReason (no further
 * retries). A truncated mid-sentence answer is bad; a second truncated
 * answer is a signal the question itself needs a real cap increase, not more
 * retries. Single call (no retry) when the first result already finished
 * cleanly.
 *
 * `retryCeiling` defaults to 2048 (the original /query-derived value) — a
 * caller whose own `cap` is already at or above that (e.g. `/match`'s 2048
 * starting point) must pass a higher ceiling explicitly, or `min(cap * 2,
 * 2048)` collapses to `cap` itself and the "retry" reruns at an identical
 * maxTokens, silently truncating the same way twice (caught 2026-08-12 —
 * `/match`'s D6 consistency test hit exactly this on `gemini-3.6-flash`).
 */
export async function generateWithLengthRetry(
  callFn: (maxTokens: number) => Promise<LengthRetryResult>,
  cap: number,
  retryCeiling = 2048,
): Promise<LengthRetryResult> {
  const first = await callFn(cap)
  if (first.finishReason !== 'length') return first
  const retryCap = Math.min(cap * 2, retryCeiling)
  return callFn(retryCap)
}
