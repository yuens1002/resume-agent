/**
 * Unit tests — src/lib/query-classify.ts
 *
 * Verifies the token-cap matrix so regressions like the "flat 512 for
 * conversational" bug (which truncated behavioral JSON responses) are caught
 * before they reach production.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isBinaryQuestion,
  isBehavioralQuestion,
  maxTokensForQuestion,
} from '../src/lib/query-classify.js'
import { generateWithLengthRetry, type LengthRetryResult } from '../src/routes/query.js'

describe('isBinaryQuestion', () => {
  it('classifies modal-opener yes/no questions as binary', () => {
    assert.equal(isBinaryQuestion('Is Alex available?'), true)
    assert.equal(isBinaryQuestion('Does Alex work remotely?'), true)
    assert.equal(isBinaryQuestion('Can Alex work remotely?'), true)
    assert.equal(isBinaryQuestion('Will Alex relocate?'), true)
    assert.equal(isBinaryQuestion('Has Alex shipped to production?'), true)
  })

  it('rejects questions with behavioral keywords despite modal opener', () => {
    // "experience" and "describe" are behavioral signals — need OB1 context
    assert.equal(isBinaryQuestion('Does Alex have React experience?'), false)
    assert.equal(isBinaryQuestion('Can Alex describe his approach?'), false)
  })

  it('rejects long questions even if they start with a modal verb', () => {
    assert.equal(
      isBinaryQuestion('Can Alex describe a time when he had to make a difficult architectural tradeoff decision on a project?'),
      false,
    )
  })

  it('rejects behavioral signals even on short modal-opener questions', () => {
    assert.equal(isBinaryQuestion('Can Alex explain his approach?'), false)
    assert.equal(isBinaryQuestion('Does Alex describe his experience well?'), false)
  })

  it('rejects non-modal openers', () => {
    assert.equal(isBinaryQuestion('Tell me about Alex'), false)
    assert.equal(isBinaryQuestion("What's Alex's availability?"), false)
    assert.equal(isBinaryQuestion('Show recent work'), false)
  })

  // #193/#197: "Have you ever …" pattern-matches the modal-opener + short-question
  // shape ("have" opener, <15 words) but is a meta/experience question, not a
  // profile-field yes/no — it needs retrieval context and the higher (non-binary)
  // token cap, not the 300-token binary ceiling that truncated this exact
  // question mid-JSON in production. Pinned verbatim (including the é
  // characters) — this is the structurally worst-shaped member of the family.
  it('excludes "Have you ever …" from binary despite the modal opener (#193/#197)', () => {
    assert.equal(isBinaryQuestion('Have you ever built a job-matching or résumé-tailoring tool?'), false)
  })

  it('keeps a true-binary question classified as binary', () => {
    assert.equal(isBinaryQuestion('Did you work at Google?'), true)
  })
})

describe('isBehavioralQuestion', () => {
  it('classifies tell-me-about and walk-me-through questions', () => {
    assert.equal(isBehavioralQuestion('Tell me about Alex'), true)
    assert.equal(isBehavioralQuestion('Walk me through his last project'), true)
  })

  it('classifies how-do-you and approach questions', () => {
    assert.equal(isBehavioralQuestion('How do you approach system design?'), true)
    assert.equal(isBehavioralQuestion("What's Alex's approach to testing?"), true)
    assert.equal(isBehavioralQuestion('How would you handle a production incident?'), true)
  })

  it('does not classify simple availability or binary questions', () => {
    assert.equal(isBehavioralQuestion('Is Alex available?'), false)
    assert.equal(isBehavioralQuestion('Show recent work'), false)
  })
})

describe('maxTokensForQuestion', () => {
  it('binary questions get 300 regardless of style', () => {
    assert.equal(maxTokensForQuestion('Is Alex available?', 'cited'), 300)
    assert.equal(maxTokensForQuestion('Is Alex available?', 'conversational'), 300)
  })

  it('behavioral questions get 1536 regardless of style (#193: raised from 1024)', () => {
    assert.equal(maxTokensForQuestion('Tell me about Alex', 'cited'), 1536)
    // regression guard: was 512 (flat conversational cap), causing truncated JSON
    assert.equal(maxTokensForQuestion('Tell me about Alex', 'conversational'), 1536)
    assert.equal(maxTokensForQuestion("What's Alex's approach to testing?", 'conversational'), 1536)
    assert.equal(maxTokensForQuestion('Walk me through his last project', 'conversational'), 1536)
  })

  // #199: fit questions narrate under the narrate-first spec and produce the
  // longest answer shape (profile-vs-role comparison). "Is Alex a fit for X?"
  // used to read as binary (starts with "Is", short) — the 300-token binary
  // cap truncated a real fit answer mid-JSON into a parse_error 500 on the
  // first live smoke test. Two layers of defense now:
  //   1. fit keywords exclude the question from isBinaryQuestion entirely
  //      (also un-skips thoughts retrieval; safety net when the classifier
  //      flag is unavailable — streaming/fallback paths get 1024, not 300)
  //   2. the classifier's narrate_fit flag raises the ceiling to 1536
  it('fit questions get 1536 with the flag, and never the binary 300 without it', () => {
    const q = 'Is Alex a fit for a Senior Backend Engineer role at a fintech startup?'
    assert.equal(isBinaryQuestion(q), false, 'fit keywords must exclude fit questions from binary')
    assert.equal(maxTokensForQuestion(q, 'cited', true), 1536)
    assert.equal(maxTokensForQuestion(q, 'conversational', true), 1536)
    // without the flag: falls to the default cap, never the binary 300
    assert.equal(maxTokensForQuestion(q, 'cited'), 1024)
    // suitability phrasings are covered by the keyword screen too
    assert.equal(isBinaryQuestion('Is Alex suited to early-stage startup work?'), false)
    assert.equal(isBinaryQuestion('Would Alex be a good hire?'), false)
  })

  it('non-binary non-behavioral questions get 1024 cited / 800 conversational', () => {
    // cited adds inline citation markers ([1][2]…) per project — 7-project exhaustive listings
    // overflow 800 in cited mode; raising cited to 1024 matches behavioral ceiling.
    // conversational has no citation markup so 800 is sufficient.
    assert.equal(maxTokensForQuestion('Show recent work', 'cited'), 1024)
    assert.equal(maxTokensForQuestion('Show recent work', 'conversational'), 800)
    assert.equal(maxTokensForQuestion("What's Alex's availability?", 'cited'), 1024)
    assert.equal(maxTokensForQuestion("What's Alex's availability?", 'conversational'), 800)
    assert.equal(maxTokensForQuestion("list all alex's projects, every single one, with a brief description of each", 'cited'), 1024)
    assert.equal(maxTokensForQuestion("list all alex's projects, every single one, with a brief description of each", 'conversational'), 800)
  })
})

// #193/#197 chunk A1: generateWithLengthRetry — retries exactly once when the
// first call truncates (finishReason 'length'), never repairs/loops further.
describe('generateWithLengthRetry', () => {
  function stubResult(finishReason: string, text: string): LengthRetryResult {
    return { text, finishReason, response: {} }
  }

  it('retries once at 2x cap when the first call truncates, and returns the retry result', async () => {
    const calls: number[] = []
    const callFn = async (maxTokens: number): Promise<LengthRetryResult> => {
      calls.push(maxTokens)
      return calls.length === 1 ? stubResult('length', 'truncated...') : stubResult('stop', 'complete answer')
    }
    const result = await generateWithLengthRetry(callFn, 1024)
    assert.deepEqual(calls, [1024, 2048])
    assert.equal(result.finishReason, 'stop')
    assert.equal(result.text, 'complete answer')
  })

  it('makes a single call when the first result already finished cleanly', async () => {
    const calls: number[] = []
    const callFn = async (maxTokens: number): Promise<LengthRetryResult> => {
      calls.push(maxTokens)
      return stubResult('stop', 'complete answer')
    }
    const result = await generateWithLengthRetry(callFn, 300)
    assert.deepEqual(calls, [300])
    assert.equal(result.finishReason, 'stop')
  })

  it('returns the retry result even if it also truncates — no further retries', async () => {
    const calls: number[] = []
    const callFn = async (maxTokens: number): Promise<LengthRetryResult> => {
      calls.push(maxTokens)
      return stubResult('length', `truncated at ${maxTokens}`)
    }
    const result = await generateWithLengthRetry(callFn, 1536)
    assert.deepEqual(calls, [1536, 2048], 'cap is min(cap*2, 2048), not unbounded')
    assert.equal(result.finishReason, 'length')
    assert.equal(result.text, 'truncated at 2048')
  })

  it('clamps the retry cap to 2048 even when cap * 2 would exceed it', async () => {
    const calls: number[] = []
    const callFn = async (maxTokens: number): Promise<LengthRetryResult> => {
      calls.push(maxTokens)
      return calls.length === 1 ? stubResult('length', 'truncated') : stubResult('stop', 'ok')
    }
    await generateWithLengthRetry(callFn, 1536)
    assert.deepEqual(calls, [1536, 2048])
  })
})
