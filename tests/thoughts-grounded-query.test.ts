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
import {
  buildQueryPrompt,
  computePromptVersion,
  responseCacheKey,
  responseCacheGet,
  responseCacheSet,
  extractProvider,
  shouldCacheResponse,
} from '../src/routes/query.js'
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
      'What else has Alex built?',
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

// #177 chunk 2: publications ride into the prompt wholesale inside the profile
// JSON — no sorting, no retrieval gating. The one adjustment is that an empty
// or absent array is dropped entirely rather than emitted as `"publications": []`,
// which would be empty-section noise for forks that never publish anything.
describe('buildQueryPrompt — publications injection (#177)', () => {
  const PUBLICATION = {
    title: 'Eval-driven development for LLM products',
    slug: 'eval-driven-development',
    platform: 'blog',
    canonical_url: 'https://example.test/eval-driven-development',
    date: '2026-05-01',
    tags: ['evals', 'llm'],
    grounded_in: 'some-concept',
  }

  it('includes the publications array wholesale in the profile JSON', () => {
    const prompt = buildQueryPrompt({ ...SAMPLE_PROFILE, publications: [PUBLICATION] }, [], 'What has the candidate published?')
    assert.ok(prompt.includes('"publications"'))
    assert.ok(prompt.includes(`"${PUBLICATION.slug}"`))
    assert.ok(prompt.includes(`"${PUBLICATION.canonical_url}"`), 'the canonical_url must reach the model, not just the title')
  })

  it('omits the publications key entirely when the array is empty', () => {
    const prompt = buildQueryPrompt({ ...SAMPLE_PROFILE, publications: [] }, [], 'What has the candidate published?')
    assert.ok(!prompt.includes('"publications"'), 'an empty publications array must not appear as noise in the prompt')
  })

  it('omits the publications key entirely when the field is absent', () => {
    const prompt = buildQueryPrompt(SAMPLE_PROFILE, [], 'What has the candidate published?')
    assert.ok(!prompt.includes('"publications"'))
  })

  it('keeps the projects filtering behavior intact alongside publications', () => {
    const profile = {
      ...SAMPLE_PROFILE,
      projects: [{ slug: 'kept-project', name: 'Kept', started: '2026-01' }],
      publications: [PUBLICATION],
    }
    const prompt = buildQueryPrompt(profile, [], 'Tell me everything')
    assert.ok(prompt.includes('"kept-project"'))
    assert.ok(prompt.includes('"publications"'))
    assert.ok(prompt.includes('# Profile data (1 projects)'), 'the project-count heading must still be derived from the filtered list')
  })
})

describe('buildQueryPrompt — HIDE_FROM_PROJECTS filtering (#176)', () => {
  const PROFILE_WITH_PROJECTS = {
    contact: { name: 'Alex', email: 'alex@example.com' },
    projects: [
      { slug: 'brew-guide', name: 'Brew Guide', started: '2025-01' },
      { slug: 'internal-tool', name: 'Internal Tool', started: '2025-06' },
      { slug: 'artisan-roast', name: 'Artisan Roast', started: '2025-03' },
    ],
  }

  it('drops the hidden project from the injected profile JSON', () => {
    const prompt = buildQueryPrompt(
      PROFILE_WITH_PROJECTS,
      [],
      'What projects has Alex built?',
      undefined,
      new Set(['internal-tool']),
    )
    assert.ok(!prompt.includes('"internal-tool"'), 'internal-tool should be filtered out of profile data')
    assert.ok(prompt.includes('"brew-guide"'), 'non-hidden project should remain')
    assert.ok(prompt.includes('"artisan-roast"'), 'non-hidden project should remain')
  })

  it('the project-count heading reflects the filtered count, not the raw count', () => {
    const prompt = buildQueryPrompt(
      PROFILE_WITH_PROJECTS,
      [],
      'What projects has Alex built?',
      undefined,
      new Set(['internal-tool']),
    )
    assert.ok(prompt.includes('# Profile data (2 projects)'), 'heading should count only the 2 visible projects')
  })

  it('composes with shown_projects — both exclusions apply together', () => {
    const prompt = buildQueryPrompt(
      PROFILE_WITH_PROJECTS,
      [],
      'What else has Alex built?',
      'shown_projects: brew-guide',
      new Set(['internal-tool']),
    )
    assert.ok(!prompt.includes('"brew-guide"'), 'shown_projects exclusion should still apply')
    assert.ok(!prompt.includes('"internal-tool"'), 'HIDE_FROM_PROJECTS exclusion should still apply')
    assert.ok(prompt.includes('"artisan-roast"'), 'the one genuinely remaining project should stay')
  })

  // Both default-call-shape tests below assert behavior that only holds when
  // HIDE_FROM_PROJECTS is genuinely unset in the running process (dev shells
  // load .env.local, which may set it) — skip rather than fail on a machine
  // where the precondition doesn't hold. CI runs them.
  const hiddenEnvSet = (process.env.HIDE_FROM_PROJECTS ?? '').trim() !== ''

  it('is a no-op when the hidden set is empty (default — HIDE_FROM_PROJECTS unset)', { skip: hiddenEnvSet && 'HIDE_FROM_PROJECTS is set in this environment' }, () => {
    const withDefault = buildQueryPrompt(PROFILE_WITH_PROJECTS, [], 'What projects has Alex built?')
    const withExplicitEmpty = buildQueryPrompt(
      PROFILE_WITH_PROJECTS,
      [],
      'What projects has Alex built?',
      undefined,
      new Set(),
    )
    assert.equal(withDefault, withExplicitEmpty)
    assert.ok(withDefault.includes('"brew-guide"'))
    assert.ok(withDefault.includes('"internal-tool"'))
    assert.ok(withDefault.includes('"artisan-roast"'))
  })

  // Invariant (#176 spec): with HIDE_FROM_PROJECTS unset — the current
  // production state — the built prompt must be byte-identical to the
  // pre-#176 unfiltered path. Build the prompt via the pre-#176 call shape
  // (4 args, no hidden-set override) and assert it exactly matches building
  // the same prompt with an explicit empty hidden set (the unfiltered path,
  // since filterVisibleProjects treats an empty Set as a pure no-op).
  it('byte-identical to the unfiltered path when HIDE_FROM_PROJECTS is unset (invariant)', { skip: hiddenEnvSet && 'HIDE_FROM_PROJECTS is set in this environment' }, () => {
    const preExisting = buildQueryPrompt(
      PROFILE_WITH_PROJECTS,
      ['some retrieved observation'],
      'Tell me about the projects',
      'recruiter',
    )
    const unfiltered = buildQueryPrompt(
      PROFILE_WITH_PROJECTS,
      ['some retrieved observation'],
      'Tell me about the projects',
      'recruiter',
      new Set(),
    )
    assert.equal(preExisting, unfiltered)
  })
})

// Regression coverage for a live incident: a cached response for the exact
// "Show recent work" starter-chip question kept serving pre-#181's broken
// open_match_tool routing well after the prompt/tool-description fix shipped,
// because nothing in the cache key changed when the routing rule or the
// tool's description changed. computePromptVersion + the prompt_version
// dimension on responseCacheKey close that gap — these tests verify the
// mechanism itself, not real prompt content, so they don't need to change
// every time a RULE_* constant (or, since #195, ROUTE_CLASSIFIER_RULE) is edited.
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

// A minimal, fully-formed QueryResponse for cache-behavior tests — the
// content doesn't matter, only whether `action_intent` is set.
function fakeResponse(actionIntent: { tool: string } | null) {
  return {
    answer: 'answer text',
    confidence: 'high' as const,
    sources: [],
    project_slugs: [],
    follow_up_suggestions: [],
    action_intent: actionIntent,
    contact: {},
    meta: { model: 'test-model', latency_ms: 1234 },
  }
}

describe('shouldCacheResponse (#188/#189)', () => {
  it('is true when action_intent is null', () => {
    assert.equal(shouldCacheResponse(fakeResponse(null)), true)
  })

  it('is false when action_intent is set', () => {
    assert.equal(shouldCacheResponse(fakeResponse({ tool: 'open_match_tool' })), false)
  })
})

describe('responseCacheGet/Set — never serve a stale action_intent-bearing entry (#188 review fix)', () => {
  // Regression coverage for the exact production incident: an
  // action_intent-bearing entry can already be sitting in the cache Map
  // (however it got there — an older code path, or a bug reintroduced
  // later) even though the current write path never puts one there itself.
  // The read side must independently refuse to serve it, not merely trust
  // that nothing bad was ever written.
  it('treats a pre-existing action_intent-bearing entry as a miss and evicts it', () => {
    const args = ['unique-q-1', 'cited', 'human', '2026-01-01', 'v1'] as const
    responseCacheSet(...args, fakeResponse({ tool: 'open_match_tool' }))
    assert.equal(responseCacheGet(...args), undefined)
    // Evicted, not just skipped — a second get must also miss (not linger as
    // a zombie entry that could resurface via a code path that forgets to check).
    assert.equal(responseCacheGet(...args), undefined)
  })

  it('still serves a normal (action_intent: null) cached entry', () => {
    const args = ['unique-q-2', 'cited', 'human', '2026-01-01', 'v1'] as const
    const response = fakeResponse(null)
    responseCacheSet(...args, response)
    assert.deepEqual(responseCacheGet(...args), response)
  })
})

describe('extractProvider (#189)', () => {
  it('extracts the provider string from an OpenRouter-shaped response body', () => {
    assert.equal(extractProvider({ body: { provider: 'Amazon Bedrock' } }), 'Amazon Bedrock')
  })

  it('returns undefined when body is missing', () => {
    assert.equal(extractProvider({}), undefined)
  })

  it('returns undefined when response itself is undefined', () => {
    assert.equal(extractProvider(undefined), undefined)
  })

  it('returns undefined when provider is present but not a string', () => {
    assert.equal(extractProvider({ body: { provider: 42 } }), undefined)
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
