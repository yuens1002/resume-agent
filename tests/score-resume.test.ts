/**
 * Unit tests — rubric scorer (score-resume.ts)
 *
 * Tests the real scoreResume() function with fixture data.
 * No network, no LLM calls, no mocks. Pure function testing.
 *
 * Run: npm run test:rubric
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scoreResume, extractJDTitle, PASS_THRESHOLD } from '../src/lib/score-resume.js'
import type { ResumeResponse } from '../src/types.js'

// ── Fixtures ─────────────────────────────────────────────

const UX_ENGINEER_JD = `
Job Description

The Sr UX Engineer at ATPCO bridges the gap between design and development, creating user-centered digital experiences.
You will collaborate with cross-functional teams, including product managers, designers, and developers, to deliver intuitive interfaces.
Your role will focus on developing front-end components, improving user experience, and supporting the ATPCO design system.

Roles and Responsibilities:
Front-End Development: Develop and maintain interactive prototypes using React, Vue, Angular.
API Integration: Integrate REST APIs into front-end applications.
UX/UI Design: Apply HCI principles to convert wireframes and mockups into production-ready experiences.
Design Systems: Contribute to the design system for consistency across products.
Accessibility: Ensure compliance with accessibility standards.
Performance Optimization: Optimize front-end code for performance.
AI-Assisted Development: Leverage AI tools (Copilot, Claude Code) to accelerate development.
`

function makeResume(overrides: Partial<ResumeResponse> = {}): ResumeResponse {
  return {
    contact: { name: 'Test User', email: 'test@example.com' },
    summary: 'Senior UX Engineer with 6+ years bridging design and development, specializing in React, TypeScript, and modern design systems.',
    skills: [
      { category: 'Frontend', items: ['React', 'Design Systems', 'Accessibility', 'REST APIs'] },
      { category: 'AI Tools', items: ['Copilot', 'Claude Code'] },
      { category: 'Languages', items: ['TypeScript', 'JavaScript', 'HTML/CSS'] },
    ],
    employment: [
      {
        company: 'Self-Employed',
        title: 'Application Developer',
        start_date: '2023-07',
        end_date: null,
        bullets: [
          'Designed 25+ reusable React components for the Artisan Roast design system, achieving sub-2s load times across mobile and desktop.',
          'Built interactive e-commerce interfaces with drag-and-drop menu builder and AI-powered recommendations, serving 500+ daily users.',
          'Integrated REST APIs with optimized state management, reducing data fetch latency by 35%.',
        ],
      },
      {
        company: 'Wipro, Inc',
        title: 'Frontend Developer',
        start_date: '2022-12',
        end_date: '2023-07',
        bullets: [
          'Led development of a responsive LAX airport application using React and Next.js, transforming 40+ Figma wireframes into production interfaces.',
          'Ensured WCAG 2.1 AA accessibility compliance across 15 interactive components, improving user engagement by 20%.',
        ],
      },
    ],
    education: [
      { institution: 'University of Washington', degree: 'BA', field: 'Arts', start_date: '1995', end_date: '1999' },
    ],
    projects: [
      {
        name: 'Artisan Roast',
        slug: 'artisan-roast',
        description: 'E-commerce platform for specialty coffee',
        problem: 'Coffee shops need affordable online ordering',
        role: 'Solo product engineer',
        tech: ['React', 'Next.js', 'TypeScript'],
        highlights: [
          'Implemented responsive design with 95+ Lighthouse performance score.',
          'Created drag-and-drop menu builder reducing store setup time by 60%.',
        ],
        status: 'active' as const,
      },
    ],
    ...overrides,
  }
}

// ── extractJDTitle ───────────────────────────────────────

describe('extractJDTitle', () => {
  it('extracts title from "The Sr UX Engineer at ATPCO bridges..."', () => {
    const title = extractJDTitle(UX_ENGINEER_JD)
    assert.ok(title.toLowerCase().includes('ux engineer'), `Expected UX Engineer, got: "${title}"`)
  })

  it('extracts title from explicit pattern "Position: Software Engineer"', () => {
    const title = extractJDTitle('Position: Software Engineer\nWe are looking for...')
    assert.equal(title, 'Software Engineer')
  })

  it('returns empty string when no title pattern found', () => {
    const title = extractJDTitle('This is a vague text with no title.')
    assert.equal(title, '')
  })

  it('strips leading adjective "a talented" from extracted title', () => {
    const title = extractJDTitle('We are looking for a talented Application Engineer to join our team.')
    assert.ok(title.toLowerCase().includes('application engineer'), `Expected "Application Engineer", got: "${title}"`)
    assert.ok(!title.toLowerCase().includes('talented'), `Should not include "talented", got: "${title}"`)
  })

  it('strips leading adjective "an experienced" from extracted title', () => {
    const title = extractJDTitle('We are hiring an experienced Software Engineer who will build...')
    assert.ok(title.toLowerCase().includes('software engineer'), `Expected "Software Engineer", got: "${title}"`)
    assert.ok(!title.toLowerCase().includes('experienced'), `Should not include "experienced", got: "${title}"`)
  })
})

// ── Rule 1: JD title in summary ─────────────────────────

describe('Rule 1 — JD title in summary', () => {
  it('passes when summary opens with JD title keywords', () => {
    const result = scoreResume(makeResume(), UX_ENGINEER_JD)
    const r1 = result.rules.find(r => r.rule === 1)!
    assert.ok(r1.pass, `Rule 1 should pass: ${r1.detail}`)
  })

  it('fails when summary opens with wrong identity', () => {
    const resume = makeResume({
      summary: 'Full-stack engineer with 6+ years of experience building web applications.',
    })
    const result = scoreResume(resume, UX_ENGINEER_JD)
    const r1 = result.rules.find(r => r.rule === 1)!
    assert.ok(!r1.pass, `Rule 1 should fail: ${r1.detail}`)
  })
})

// ── Rule 2: Keyword coverage ────────────────────────────

describe('Rule 2 — Keyword coverage', () => {
  it('achieves reasonable coverage for a well-tailored resume', () => {
    const result = scoreResume(makeResume(), UX_ENGINEER_JD)
    const r2 = result.rules.find(r => r.rule === 2)!
    assert.ok(r2.score > 0.5, `Expected good coverage, got score ${r2.score}: ${r2.detail}`)
  })

  it('low coverage for a completely unrelated resume', () => {
    const resume = makeResume({
      summary: 'Plumber with 10 years fixing pipes.',
      skills: [{ category: 'Plumbing', items: ['Pipes', 'Welding', 'Copper'] }],
      employment: [{
        company: 'Pipe Co', title: 'Plumber', start_date: '2015-01', end_date: null,
        bullets: ['Fixed 500 pipes in residential buildings.'],
      }],
    })
    const result = scoreResume(resume, UX_ENGINEER_JD)
    const r2 = result.rules.find(r => r.rule === 2)!
    assert.ok(r2.score < 0.4, `Expected low coverage, got score ${r2.score}: ${r2.detail}`)
  })
})

// ── Rule 3: Quantified bullets ──────────────────────────

describe('Rule 3 — Quantified bullets', () => {
  it('passes when most bullets have metrics', () => {
    const result = scoreResume(makeResume(), UX_ENGINEER_JD)
    const r3 = result.rules.find(r => r.rule === 3)!
    assert.ok(r3.pass, `Rule 3 should pass: ${r3.detail}`)
  })

  it('fails when no bullets have metrics', () => {
    const resume = makeResume({
      employment: [{
        company: 'Co', title: 'Dev', start_date: '2020-01', end_date: null,
        bullets: [
          'Worked on front-end components.',
          'Collaborated with designers.',
          'Improved user experience.',
        ],
      }],
      projects: [],
    })
    const result = scoreResume(resume, UX_ENGINEER_JD)
    const r3 = result.rules.find(r => r.rule === 3)!
    assert.ok(!r3.pass, `Rule 3 should fail: ${r3.detail}`)
  })
})

// ── Rule 4: Authenticity ────────────────────────────────

describe('Rule 4 — Authenticity (no generic phrases)', () => {
  it('passes when resume has no banned phrases', () => {
    const result = scoreResume(makeResume(), UX_ENGINEER_JD)
    const r4 = result.rules.find(r => r.rule === 4)!
    assert.ok(r4.pass, `Rule 4 should pass: ${r4.detail}`)
  })

  it('fails when summary contains "proven track record"', () => {
    const resume = makeResume({
      summary: 'Results-driven UX engineer with a proven track record of leveraging synergies.',
    })
    const result = scoreResume(resume, UX_ENGINEER_JD)
    const r4 = result.rules.find(r => r.rule === 4)!
    assert.ok(!r4.pass, `Rule 4 should fail: ${r4.detail}`)
    assert.ok(r4.detail.includes('results-driven'), `Should list found phrase: ${r4.detail}`)
  })
})

// ── Rule 6: Skills ordering ─────────────────────────────

describe('Rule 6 — Skills ordered by JD relevance', () => {
  it('passes when top skills match JD requirements', () => {
    const result = scoreResume(makeResume(), UX_ENGINEER_JD)
    const r6 = result.rules.find(r => r.rule === 6)!
    assert.ok(r6.pass, `Rule 6 should pass: ${r6.detail}`)
  })

  it('fails when top skills are irrelevant to JD', () => {
    const resume = makeResume({
      skills: [
        { category: 'Backend', items: ['Rust', 'CUDA', 'Assembly', 'FORTRAN', 'COBOL'] },
      ],
    })
    const result = scoreResume(resume, UX_ENGINEER_JD)
    const r6 = result.rules.find(r => r.rule === 6)!
    assert.ok(!r6.pass, `Rule 6 should fail: ${r6.detail}`)
  })
})

// ── Overall scoring ─────────────────────────────────────

describe('Overall rubric scoring', () => {
  it('well-tailored resume passes threshold', () => {
    const result = scoreResume(makeResume(), UX_ENGINEER_JD)
    assert.ok(result.passed, `Expected pass (${result.total.toFixed(1)} >= ${PASS_THRESHOLD}), rules: ${result.rules.map(r => `R${r.rule}:${r.score.toFixed(2)}`).join(', ')}`)
  })

  it('returns 5 rule results', () => {
    const result = scoreResume(makeResume(), UX_ENGINEER_JD)
    assert.equal(result.rules.length, 5)
  })

  it('total is sum of individual scores', () => {
    const result = scoreResume(makeResume(), UX_ENGINEER_JD)
    const expectedTotal = result.rules.reduce((s, r) => s + r.score, 0)
    assert.ok(Math.abs(result.total - expectedTotal) < 0.01, `Total ${result.total} != sum ${expectedTotal}`)
  })
})
