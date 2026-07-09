/**
 * Unit tests — thoughts-grounded /query.
 *
 * Covers the unit-testable slice of docs/plans/thoughts-grounded-query.md:
 *   - AC-6 / AC-7: prompt shape with and without injected thoughts
 *   - AC-9 (unit-level): the prompt builder is a pure function of its inputs —
 *     it never filters, so privacy must be (and is) enforced upstream in SQL
 *   - AC-1 / AC-2: the match_thoughts_public migration exists and carries the
 *     index-friendly privacy guard
 *
 * The DB- and LLM-dependent ACs (AC-3 truncation/large-window, AC-4/AC-5 helper
 * behavior against a live RPC, AC-8 public-MCP parity, AC-9 end-to-end privacy,
 * AC-10 /resume regression, AC-11 agent-card surface) are exercised by the
 * integration and public-MCP suites and a live smoke run.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildQueryPrompt } from '../src/routes/query.js'
import { getQuestionThreshold } from '../src/lib/thoughts-query.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

const SAMPLE_PROFILE = {
  contact: { name: 'Test Candidate', email: 'test@example.com' },
  skills: [{ category: 'Languages', items: ['TypeScript'] }],
}

describe('buildQueryPrompt — with injected thoughts (AC-6)', () => {
  const thoughts = [
    'Chose Prisma over raw SQL because the team velocity gain outweighed the query-control loss for this app size.',
    'Stopped iterating on the search ranker once the eval suite plateaued — diminishing returns vs. shipping.',
  ]
  const prompt = buildQueryPrompt(SAMPLE_PROFILE, thoughts, 'How do you decide what to build?')

  it('includes the labeled observations heading', () => {
    assert.match(prompt, /# Project observations and lived experience/)
  })

  it('renders each thought as a bullet', () => {
    for (const t of thoughts) {
      assert.ok(prompt.includes(`- ${t}`), `expected bullet for: ${t.slice(0, 40)}…`)
    }
  })

  it('places the observations block above the profile data', () => {
    const obsIdx = prompt.indexOf('# Project observations and lived experience')
    const profileIdx = prompt.indexOf('# Profile data')
    assert.ok(obsIdx >= 0 && profileIdx >= 0)
    assert.ok(obsIdx < profileIdx, 'observations must come before profile data')
  })

  it('still includes the profile JSON and the question last', () => {
    assert.ok(prompt.includes('"Test Candidate"'))
    assert.ok(prompt.trimEnd().endsWith('How do you decide what to build?'))
    const questionIdx = prompt.indexOf('# Question')
    assert.ok(questionIdx > prompt.indexOf('# Profile data'), 'question section comes last')
  })
})

describe('buildQueryPrompt — without thoughts (AC-7)', () => {
  const prompt = buildQueryPrompt(SAMPLE_PROFILE, [], 'What is your experience with TypeScript?')

  it('omits the observations heading entirely', () => {
    assert.ok(!prompt.includes('# Project observations and lived experience'))
  })

  it('keeps the profile-then-question structure', () => {
    const profileIdx = prompt.indexOf('# Profile data')
    const questionIdx = prompt.indexOf('# Question')
    assert.ok(profileIdx >= 0 && questionIdx > profileIdx)
  })
})

describe('buildQueryPrompt — pure function of inputs (AC-9, unit level)', () => {
  it('renders whatever thoughts it is handed — it does not filter', () => {
    // The prompt builder has no notion of "private". If a private thought ever
    // reaches this function it WOULD be rendered — which is exactly why the
    // privacy filter lives in match_thoughts_public (SQL), not here.
    const sneaky = 'PRIVATE: this should never have reached the prompt builder'
    const prompt = buildQueryPrompt(SAMPLE_PROFILE, [sneaky], 'anything')
    assert.ok(prompt.includes(`- ${sneaky}`))
  })
})

describe('buildQueryPrompt — shown_projects filtering', () => {
  const PROFILE_WITH_PROJECTS = {
    contact: { name: 'Test Candidate', email: 'test@example.com' },
    projects: [
      { slug: 'brew-guide', name: 'Brew Guide', started: '2025-01' },
      { slug: 'resume-agent', name: 'Resume Agent', started: '2025-06' },
      { slug: 'artisan-roast', name: 'Artisan Roast', started: '2025-03' },
    ],
  }

  it('drops projects whose slug is in shown_projects from the injected JSON', () => {
    const prompt = buildQueryPrompt(
      PROFILE_WITH_PROJECTS,
      [],
      'What else has Sunny built?',
      'shown_projects: brew-guide, resume-agent',
    )
    assert.ok(!prompt.includes('"brew-guide"'), 'brew-guide should be filtered out of profile data')
    assert.ok(!prompt.includes('"resume-agent"'), 'resume-agent should be filtered out of profile data')
    assert.ok(prompt.includes('"artisan-roast"'), 'artisan-roast (not yet shown) should remain')
  })

  it('keeps all projects when shown_projects is absent', () => {
    const prompt = buildQueryPrompt(PROFILE_WITH_PROJECTS, [], 'Tell me about the projects', 'recruiter')
    assert.ok(prompt.includes('"brew-guide"'))
    assert.ok(prompt.includes('"resume-agent"'))
    assert.ok(prompt.includes('"artisan-roast"'))
  })

  it('filters correctly when shown_projects follows a caller-type prefix', () => {
    const prompt = buildQueryPrompt(
      PROFILE_WITH_PROJECTS,
      [],
      'What else?',
      'recruiter; shown_projects: artisan-roast',
    )
    assert.ok(!prompt.includes('"artisan-roast"'))
    assert.ok(prompt.includes('"brew-guide"'))
    assert.ok(prompt.includes('"resume-agent"'))
  })

  it('never surfaces the raw shown_projects field to the model — the exclusion is enforced by omission, not instruction', () => {
    // Regression test: leaving the raw slug list visible in the caller-context
    // block let the model treat excluded slugs as topics to discuss, pulling
    // in unrelated observations that happened to name them. Once the
    // projects are actually removed from the data, the model has no need
    // (and must not be given the means) to reconstruct them from the hint.
    const prompt = buildQueryPrompt(
      PROFILE_WITH_PROJECTS,
      [],
      'What else?',
      'recruiter; shown_projects: brew-guide, resume-agent',
    )
    assert.ok(!prompt.includes('shown_projects'), 'raw shown_projects field must not reach the model')
  })

  it('keeps the rest of the caller-context hint when shown_projects is stripped', () => {
    const prompt = buildQueryPrompt(
      PROFILE_WITH_PROJECTS,
      [],
      'What else?',
      'recruiter; shown_projects: brew-guide',
    )
    assert.ok(prompt.includes('recruiter'), 'non-shown_projects caller-context content should still reach the model')
  })

  it('omits the Caller context block entirely when shown_projects was the only content', () => {
    const prompt = buildQueryPrompt(
      PROFILE_WITH_PROJECTS,
      [],
      'What else?',
      'shown_projects: brew-guide, resume-agent',
    )
    assert.ok(!prompt.includes('# Caller context'), 'no caller-context block needed once shown_projects is stripped to empty')
  })
})

describe('match_thoughts_public migration (AC-1, AC-2)', () => {
  const migration = readFileSync(
    join(repoRoot, 'supabase', 'migrations', '20260512000000_match_thoughts_public.sql'),
    'utf8',
  )

  it('defines the match_thoughts_public function', () => {
    assert.match(migration, /create or replace function match_thoughts_public/i)
  })

  it('carries the index-friendly privacy guard (JSONB containment, not a cast)', () => {
    assert.ok(
      migration.includes(`not (t.metadata @> '{"private": true}'::jsonb)`),
      'expected the `@>` containment exclusion for private thoughts',
    )
    assert.ok(!/->>\s*'private'/.test(migration), 'should not use a ->> text cast for the privacy check')
  })
})

describe('getQuestionThreshold — env override is clamped to [0, 1]', () => {
  const orig = process.env.QUERY_THOUGHTS_THRESHOLD
  const restore = () => {
    if (orig === undefined) delete process.env.QUERY_THOUGHTS_THRESHOLD
    else process.env.QUERY_THOUGHTS_THRESHOLD = orig
  }

  it('returns the default (0.35) when the env var is unset', () => {
    delete process.env.QUERY_THOUGHTS_THRESHOLD
    assert.equal(getQuestionThreshold(), 0.35)
    restore()
  })

  it('honors a valid in-range value', () => {
    process.env.QUERY_THOUGHTS_THRESHOLD = '0.5'
    assert.equal(getQuestionThreshold(), 0.5)
    restore()
  })

  it('falls back to default on non-numeric input', () => {
    process.env.QUERY_THOUGHTS_THRESHOLD = 'banana'
    assert.equal(getQuestionThreshold(), 0.35)
    restore()
  })

  it('falls back to default on negative values', () => {
    process.env.QUERY_THOUGHTS_THRESHOLD = '-0.5'
    assert.equal(getQuestionThreshold(), 0.35)
    restore()
  })

  it('falls back to default on values > 1', () => {
    process.env.QUERY_THOUGHTS_THRESHOLD = '1.5'
    assert.equal(getQuestionThreshold(), 0.35)
    restore()
  })

  it('accepts 0 and 1 (boundary values)', () => {
    process.env.QUERY_THOUGHTS_THRESHOLD = '0'
    assert.equal(getQuestionThreshold(), 0)
    process.env.QUERY_THOUGHTS_THRESHOLD = '1'
    assert.equal(getQuestionThreshold(), 1)
    restore()
  })
})
