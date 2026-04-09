/**
 * Unit tests — banned phrase post-filter (strip-banned.ts)
 *
 * Tests that stripBannedPhrases() catches and neutralises every banned
 * phrase, works case-insensitively, returns a new object, and passes
 * clean resumes through unchanged.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stripBannedPhrases } from '../src/lib/strip-banned.js'
import { BANNED_PHRASES } from '../src/lib/score-resume.js'
import type { ResumeResponse } from '../src/types.js'

// ── Fixtures ─────────────────────────────────────────────

function makeResume(overrides: Partial<ResumeResponse> = {}): ResumeResponse {
  return {
    contact: { name: 'Test User', email: 'test@example.com' },
    summary: 'Experienced engineer building web applications.',
    skills: [{ category: 'Frontend', items: ['React', 'TypeScript'] }],
    employment: [
      {
        company: 'Acme',
        title: 'Engineer',
        start_date: '2020-01',
        end_date: null,
        bullets: ['Built a component library for the design system.'],
      },
    ],
    education: [
      { institution: 'University', degree: 'BS', field: 'CS', start_date: '2014', end_date: '2018' },
    ],
    projects: [
      {
        name: 'Side Project',
        slug: 'side-project',
        description: 'A project',
        problem: 'A problem',
        role: 'Developer',
        tech: ['React'],
        highlights: ['Shipped v1 with 100% test coverage.'],
        status: 'active' as const,
      },
    ],
    ...overrides,
  }
}

function containsBanned(text: string): boolean {
  return BANNED_PHRASES.some(p => text.toLowerCase().includes(p.toLowerCase()))
}

// ── Tests ────────────────────────────────────────────────

describe('stripBannedPhrases', () => {
  it('BANNED_PHRASES is exported from score-resume', () => {
    assert.ok(Array.isArray(BANNED_PHRASES))
    assert.ok(BANNED_PHRASES.length > 0)
  })

  it('strips banned phrases from summary', () => {
    const resume = makeResume({
      summary: 'A results-driven engineer with a proven track record of leveraging modern tools.',
    })
    const cleaned = stripBannedPhrases(resume)
    assert.ok(!containsBanned(cleaned.summary), `Summary still contains banned phrase: "${cleaned.summary}"`)
  })

  it('strips banned phrases from employment bullets', () => {
    const resume = makeResume({
      employment: [
        {
          company: 'Acme',
          title: 'Engineer',
          start_date: '2020-01',
          end_date: null,
          bullets: [
            'Spearheaded the redesign of the checkout flow.',
            'A dynamic team player who leveraging synergies across teams.',
          ],
        },
      ],
    })
    const cleaned = stripBannedPhrases(resume)
    for (const bullet of cleaned.employment[0].bullets) {
      assert.ok(!containsBanned(bullet), `Bullet still contains banned phrase: "${bullet}"`)
    }
  })

  it('strips banned phrases from project highlights', () => {
    const resume = makeResume({
      projects: [
        {
          name: 'Project',
          slug: 'project',
          description: 'desc',
          problem: 'prob',
          role: 'dev',
          tech: ['React'],
          highlights: ['A highly motivated self-starter who thinks outside the box.'],
          status: 'active' as const,
        },
      ],
    })
    const cleaned = stripBannedPhrases(resume)
    for (const h of cleaned.projects[0].highlights) {
      assert.ok(!containsBanned(h), `Highlight still contains banned phrase: "${h}"`)
    }
  })

  it('handles case-insensitive matches', () => {
    const resume = makeResume({
      summary: 'A PROVEN TRACK RECORD of Leveraging SYNERGIES.',
    })
    const cleaned = stripBannedPhrases(resume)
    assert.ok(!containsBanned(cleaned.summary), `Summary still contains banned phrase: "${cleaned.summary}"`)
  })

  it('replaces "leveraging" → "using" with correct grammar', () => {
    const resume = makeResume({
      summary: 'Engineer leveraging modern tools to build products.',
    })
    const cleaned = stripBannedPhrases(resume)
    assert.ok(cleaned.summary.includes('using'), `Expected "using" in: "${cleaned.summary}"`)
    assert.ok(!cleaned.summary.includes('leveraging'), `Still has "leveraging" in: "${cleaned.summary}"`)
  })

  it('replaces "spearheaded" → "led"', () => {
    const resume = makeResume({
      employment: [
        {
          company: 'Acme',
          title: 'Engineer',
          start_date: '2020-01',
          end_date: null,
          bullets: ['Spearheaded the migration to a new framework.'],
        },
      ],
    })
    const cleaned = stripBannedPhrases(resume)
    assert.ok(cleaned.employment[0].bullets[0].includes('Led'), `Expected "Led" in: "${cleaned.employment[0].bullets[0]}"`)
  })

  it('returns a new object — input is not mutated', () => {
    const resume = makeResume({
      summary: 'A results-driven engineer.',
    })
    const original = resume.summary
    const cleaned = stripBannedPhrases(resume)
    assert.notEqual(cleaned, resume, 'Should return a new object')
    assert.equal(resume.summary, original, 'Original should not be mutated')
  })

  it('passes clean resume through unchanged', () => {
    const resume = makeResume()
    const cleaned = stripBannedPhrases(resume)
    assert.deepEqual(cleaned.summary, resume.summary)
    assert.deepEqual(cleaned.employment[0].bullets, resume.employment[0].bullets)
    assert.deepEqual(cleaned.projects[0].highlights, resume.projects[0].highlights)
  })

  it('does not leave double spaces after removal', () => {
    const resume = makeResume({
      summary: 'A results-driven detail-oriented professional engineer.',
    })
    const cleaned = stripBannedPhrases(resume)
    assert.ok(!cleaned.summary.includes('  '), `Double spaces in: "${cleaned.summary}"`)
  })
})
