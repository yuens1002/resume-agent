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
import { buildQueryPrompt, deriveActionIntent, computePromptVersion, responseCacheKey } from '../src/routes/query.js'
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

  it('fully filters shown_projects even when the slug list exceeds sanitizeCallerHint\'s 200-char cap', () => {
    // Regression test (Copilot review on PR #175): shownSlugs used to be parsed
    // from the *sanitized* hint, which hard-truncates at 200 chars. A long
    // enough slug list would get cut off mid-list, so slugs past the cutoff
    // silently stopped being excluded — reintroducing the exact duplication
    // bug this filtering exists to fix. Slugs must be parsed from the raw,
    // untruncated callerHint instead.
    const manyProjectsProfile = {
      contact: { name: 'Test Candidate', email: 'test@example.com' },
      projects: [
        { slug: 'project-alpha-long-descriptive-name', started: '2025-01' },
        { slug: 'project-bravo-long-descriptive-name', started: '2025-02' },
        { slug: 'project-charlie-long-descriptive-name', started: '2025-03' },
        { slug: 'project-delta-long-descriptive-name', started: '2025-04' },
        { slug: 'project-echo-long-descriptive-name', started: '2025-05' },
        { slug: 'project-foxtrot-long-descriptive-name', started: '2025-06' },
        { slug: 'project-golf-long-descriptive-name', started: '2025-07' },
        { slug: 'project-hotel-not-yet-shown', started: '2025-08' },
      ],
    }
    const shown = manyProjectsProfile.projects.slice(0, 7).map((p) => p.slug)
    const context = `human; shown_projects: ${shown.join(', ')}`
    assert.ok(context.length > 200, `test fixture must exceed the 200-char cap to exercise the bug (got ${context.length})`)

    const prompt = buildQueryPrompt(manyProjectsProfile, [], 'What else?', context)
    for (const slug of shown) {
      assert.ok(!prompt.includes(`"${slug}"`), `${slug} should be filtered out even though it's past the 200-char truncation point`)
    }
    assert.ok(prompt.includes('"project-hotel-not-yet-shown"'), 'the one genuinely unseen project should remain')
  })
})

describe('deriveActionIntent (#174)', () => {
  it('returns null when no tool calls are present', () => {
    assert.equal(deriveActionIntent([]), null)
  })

  it('returns null when a tool call is present but not open_match_tool', () => {
    assert.equal(deriveActionIntent([{ toolName: 'some_other_tool' }]), null)
  })

  it('returns { tool: "open_match_tool" } when the model called it', () => {
    assert.deepEqual(deriveActionIntent([{ toolName: 'open_match_tool' }]), { tool: 'open_match_tool' })
  })

  it('finds open_match_tool among multiple tool calls', () => {
    assert.deepEqual(
      deriveActionIntent([{ toolName: 'some_other_tool' }, { toolName: 'open_match_tool' }]),
      { tool: 'open_match_tool' },
    )
  })
})

// Regression coverage for a live incident: a cached response for the exact
// "Show recent work" starter-chip question kept serving pre-#181's broken
// open_match_tool routing well after the prompt/tool-description fix shipped,
// because nothing in the cache key changed when RULE_ACTION_INTENT or the
// tool's description changed. computePromptVersion + the prompt_version
// dimension on responseCacheKey close that gap — these tests verify the
// mechanism itself, not real prompt content, so they don't need to change
// every time a RULE_* constant is edited.
describe('computePromptVersion — response cache invalidation on prompt-logic change', () => {
  it('is deterministic: identical inputs produce identical output', () => {
    assert.equal(computePromptVersion('a', 'b', 'c'), computePromptVersion('a', 'b', 'c'))
  })

  it('changes when any single input differs', () => {
    const base = computePromptVersion('rule one', 'rule two', 'tool description')
    assert.notEqual(base, computePromptVersion('rule ONE', 'rule two', 'tool description'))
    assert.notEqual(base, computePromptVersion('rule one', 'rule TWO', 'tool description'))
    assert.notEqual(base, computePromptVersion('rule one', 'rule two', 'tool DESCRIPTION'))
  })
})

describe('responseCacheKey — prompt_version is a load-bearing cache dimension', () => {
  it('produces a different key when only promptVersion differs, all else held equal', () => {
    const keyOld = responseCacheKey('Show recent work', 'cited', 'human', '2026-01-01', 'v1', 'prompt-v1')
    const keyNew = responseCacheKey('Show recent work', 'cited', 'human', '2026-01-01', 'v1', 'prompt-v2')
    assert.notEqual(keyOld, keyNew)
  })

  it('produces identical keys for identical inputs including promptVersion', () => {
    const a = responseCacheKey('Show recent work', 'cited', 'human', '2026-01-01', 'v1', 'prompt-v1')
    const b = responseCacheKey('Show recent work', 'cited', 'human', '2026-01-01', 'v1', 'prompt-v1')
    assert.equal(a, b)
  })

  // Copilot review (PR #187): the original ":"-joined key format could collide
  // when a field itself contains ":" — e.g. thoughtsVersion's `error:${now}`
  // fallback, or an ISO timestamp in profileUpdatedAt. A naive shift of where
  // one field ends and the next begins could make two distinct tuples produce
  // the same string. JSON-encoding the tuple instead of delimiter-joining it
  // rules this out structurally.
  it('does not collide when a field value itself contains the old ":" delimiter', () => {
    const a = responseCacheKey('q', 'cited', 'human', 'error:12345', 'v1', 'pv1')
    const b = responseCacheKey('q', 'cited', 'human', 'error', '12345:v1', 'pv1')
    assert.notEqual(a, b)
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
