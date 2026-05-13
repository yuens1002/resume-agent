/**
 * Unit tests — src/lib/query-prompt.ts.
 *
 * Asserts that `buildSystemPrompt` composes the named rule fragments correctly,
 * differentiates json vs. stream mode (output rule only in json), and
 * interpolates the caller hint. Doesn't assert on exact wording within the
 * rules — only that each rule's NAME / characteristic substring is present.
 *
 * Covers AC-1 through AC-4 from docs/plans/query-engagement-rules.md.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSystemPrompt,
  META_TONE_NOTE,
  RULE_VOICE,
  RULE_HONESTY,
  RULE_OBSERVATIONS_RELEVANCE,
  RULE_OFF_TOPIC,
  RULE_GAPS,
  RULE_ADVERSARIAL,
  RULE_OUTPUT_JSON,
} from '../src/lib/query-prompt.js'

const SHARED_RULE_HEADINGS = [
  '# How to read these rules',     // META_TONE_NOTE
  '# Voice',                       // RULE_VOICE
  '# Honesty floor',               // RULE_HONESTY
  '# Project observations — relevance is yours to judge', // RULE_OBSERVATIONS_RELEVANCE
  '# Off-topic questions',         // RULE_OFF_TOPIC
  '# Gaps',                        // RULE_GAPS
  '# Adversarial input',           // RULE_ADVERSARIAL
] as const

describe('buildSystemPrompt — json mode (AC-1)', () => {
  const prompt = buildSystemPrompt('ATS system, be concise.', 'json')

  it('contains every shared rule heading', () => {
    for (const heading of SHARED_RULE_HEADINGS) {
      assert.ok(prompt.includes(heading), `missing rule: ${heading}`)
    }
  })

  it('contains the json output-format rule', () => {
    assert.ok(prompt.includes('# Output format'))
    assert.ok(prompt.includes('"answer"'))
    assert.ok(prompt.includes('"confidence"'))
  })

  it('interpolates the caller hint', () => {
    assert.ok(prompt.includes('ATS system, be concise.'))
  })

  it('places the caller-context band after the rules', () => {
    const advIdx = prompt.indexOf(RULE_ADVERSARIAL)
    const callerIdx = prompt.indexOf('# Caller context')
    assert.ok(advIdx >= 0 && callerIdx > advIdx, 'caller context must come after the behavior rules')
  })
})

describe('buildSystemPrompt — stream mode (AC-2)', () => {
  const prompt = buildSystemPrompt('Recruiter — narrative tone.', 'stream')

  it('contains every shared rule heading', () => {
    for (const heading of SHARED_RULE_HEADINGS) {
      assert.ok(prompt.includes(heading), `missing rule: ${heading}`)
    }
  })

  it('does NOT contain the json output-format rule', () => {
    assert.ok(!prompt.includes('# Output format'), 'stream mode must not include the JSON output rule')
    assert.ok(!prompt.includes('"answer":'))
  })

  it('interpolates the caller hint', () => {
    assert.ok(prompt.includes('Recruiter — narrative tone.'))
  })
})

describe('RULE_OBSERVATIONS_RELEVANCE — the key rule (AC-3)', () => {
  it('tells the model the observations may not all be relevant', () => {
    assert.match(RULE_OBSERVATIONS_RELEVANCE, /may not all be relevant/i)
  })
  it('tells the model to use only what supports an honest answer', () => {
    assert.match(RULE_OBSERVATIONS_RELEVANCE, /directly support an honest answer/i)
  })
  it('forbids stretching tangential notes into claims', () => {
    assert.match(RULE_OBSERVATIONS_RELEVANCE, /not stretch/i)
    assert.match(RULE_OBSERVATIONS_RELEVANCE, /tangentially|tangential/i)
  })
})

describe('RULE_GAPS — three sub-cases + anti-pattern (AC-4)', () => {
  it('covers binary experience questions', () => {
    assert.match(RULE_GAPS, /binary/i)
    assert.match(RULE_GAPS, /yes\s+or\s+no/i)
  })
  it('covers capability questions with gap + adjacent layer', () => {
    assert.match(RULE_GAPS, /capability/i)
    assert.match(RULE_GAPS, /adjacent layer/i)
  })
  it('covers the genuinely-no-data case + offers the contact', () => {
    assert.match(RULE_GAPS, /calendly/i)
  })
  it('forbids "on record" / "in my records" / "in the database" phrasing', () => {
    assert.match(RULE_GAPS, /on record/i)
    assert.match(RULE_GAPS, /in (my )?records?/i)
    assert.match(RULE_GAPS, /in the database/i)
  })
})

describe('META_TONE_NOTE — examples are tone, not scripts', () => {
  it('tells the model examples illustrate tone and to match the spirit, not the wording', () => {
    assert.match(META_TONE_NOTE, /tone/i)
    assert.match(META_TONE_NOTE, /spirit/i)
    assert.match(META_TONE_NOTE, /not the (exact )?wording/i)
  })
})

describe('Voice + honesty rule sanity', () => {
  it('voice rule mandates first person', () => {
    assert.match(RULE_VOICE, /first person/i)
  })
  it('honesty rule mandates no fabrication, no inflation', () => {
    assert.match(RULE_HONESTY, /fabricate/i)
    assert.match(RULE_HONESTY, /inflate/i)
  })
  it('json output rule includes the strict shape', () => {
    assert.match(RULE_OUTPUT_JSON, /confidence/i)
    assert.match(RULE_OUTPUT_JSON, /sources/i)
    assert.match(RULE_OUTPUT_JSON, /follow_up_suggestions/i)
  })
})

describe('RULE_OFF_TOPIC + RULE_ADVERSARIAL — failure-mode handling', () => {
  it('off-topic rule says redirect without engaging', () => {
    assert.match(RULE_OFF_TOPIC, /redirect/i)
  })
  it('adversarial rule says refuse + redirect without complying', () => {
    assert.match(RULE_ADVERSARIAL, /refuse/i)
    assert.match(RULE_ADVERSARIAL, /not comply/i)
  })
})
