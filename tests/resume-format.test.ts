/**
 * Unit tests — resume-format.ts (#298) and the STAR/XYZ rubric rule.
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RESUME_BUDGET, capSentences, cleanBullet, normalizeResumeFormat } from '../src/lib/resume-format.js'
import { isXyzBullet, scoreResume, PASS_THRESHOLD } from '../src/lib/score-resume.js'
import type { ResumeResponse } from '../src/types.js'

function resume(overrides: Partial<ResumeResponse> = {}): ResumeResponse {
  return {
    contact: { name: 'Test User', email: 'test@example.com' },
    summary: 'Senior engineer.',
    skills: [],
    employment: [],
    education: [],
    projects: [],
    ...overrides,
  } as ResumeResponse
}

const job = (company: string, start: string, n: number) => ({
  company, title: 'Engineer', start_date: start, end_date: null,
  bullets: Array.from({ length: n }, (_, i) => `Built feature ${i + 1}.`),
})

describe('cleanBullet', () => {
  it('drops trailing periods and spells out a standalone ampersand', () => {
    assert.equal(cleanBullet('Built APIs & dashboards.'), 'Built APIs and dashboards')
  })
  it('leaves an ampersand inside a name alone', () => {
    assert.equal(cleanBullet('Led R&D prototypes'), 'Led R&D prototypes')
  })
})

describe('capSentences', () => {
  it('keeps the first N sentences and ignores periods inside tokens', () => {
    assert.equal(capSentences('Built on Node.js and React. Owns delivery. Explores AI.', 2), 'Built on Node.js and React. Owns delivery.')
  })
})

describe('normalizeResumeFormat', () => {
  it('orders roles most recent first and applies the bullet budget', () => {
    const out = normalizeResumeFormat(resume({ employment: [job('Old Co', '2018-01', 5), job('New Co', '2022-01', 6)] }))
    assert.deepEqual(out.employment.map((e) => e.company), ['New Co', 'Old Co'])
    assert.equal(out.employment[0].bullets.length, RESUME_BUDGET.mostRecentRoleBullets)
    assert.equal(out.employment[1].bullets.length, RESUME_BUDGET.otherRoleBullets)
    assert.ok(out.employment.every((e) => e.bullets.every((b) => !b.endsWith('.'))))
  })

  it('caps projects, highlights and categorized skill rows', () => {
    const project = (name: string) => ({ name, slug: name, highlights: ['a', 'b', 'c', 'd', 'e'] })
    const out = normalizeResumeFormat(resume({
      projects: [project('A'), project('B'), project('C')] as ResumeResponse['projects'],
      skills: Array.from({ length: 6 }, (_, i) => ({ category: `Row ${i}`, items: ['x'] })),
    }))
    assert.equal(out.projects.length, RESUME_BUDGET.projects)
    assert.ok(out.projects.every((p) => p.highlights.length === RESUME_BUDGET.projectHighlights))
    assert.equal(out.skills.length, RESUME_BUDGET.skillRows)
  })

  it('drops self-employment bullets that restate a featured project, keeping at least one', () => {
    const selfEmployed = {
      company: 'Self-Employed', title: 'Product Engineer', start_date: '2023-08', end_date: null,
      bullets: ['Built the StayOps onboarding flow', 'Shipped 3 products end to end'],
    }
    const out = normalizeResumeFormat(resume({
      employment: [selfEmployed],
      projects: [{ name: 'StayOps', slug: 'stayops', highlights: [] }] as unknown as ResumeResponse['projects'],
    }))
    assert.deepEqual(out.employment[0].bullets, ['Shipped 3 products end to end'])

    const onlyDupes = normalizeResumeFormat(resume({
      employment: [{ ...selfEmployed, bullets: ['Built the StayOps onboarding flow'] }],
      projects: [{ name: 'StayOps', slug: 'stayops', highlights: [] }] as unknown as ResumeResponse['projects'],
    }))
    assert.equal(onlyDupes.employment[0].bullets.length, 1)
  })

  it('never adds a digit to any bullet (output digits are a subset of input digits)', () => {
    const input = resume({
      employment: [
        { ...job('A', '2022-01', 0), bullets: ['Built APIs & dashboards.', 'Cut p95 from 11.3s to 320ms by caching.', 'Led a 5-person team'] },
        { ...job('B', '2019-01', 0), bullets: ['Shipped v2.', 'Ran QA'] },
      ],
      projects: [{ name: 'Proj', slug: 'proj', highlights: ['Reached 99% uptime.'] }] as unknown as ResumeResponse['projects'],
    })
    const digits = (r: ResumeResponse) => new Set(
      [...r.employment.flatMap((e) => e.bullets), ...r.projects.flatMap((p) => p.highlights)].join(' ').match(/\d/g) ?? [],
    )
    const out = normalizeResumeFormat(input)
    for (const d of digits(out)) assert.ok(digits(input).has(d), `digit ${d} was introduced`)
  })

  it('passes a flat string skills list through unchanged', () => {
    const skills = ['TypeScript', 'React', 'Node.js', 'Postgres', 'Vitest'] as unknown as ResumeResponse['skills']
    assert.deepEqual(normalizeResumeFormat(resume({ skills })).skills, skills)
  })

  it('ignores project names shorter than the dedupe floor', () => {
    const out = normalizeResumeFormat(resume({
      employment: [{ company: 'Self-Employed', title: 'Engineer', start_date: '2023-08', end_date: null, bullets: ['Built UX research tooling', 'Shipped a design system'] }],
      projects: [{ name: 'UX', slug: 'ux', highlights: [] }] as unknown as ResumeResponse['projects'],
    }))
    assert.equal(out.employment[0].bullets.length, 2)
  })
})

describe('pinned employment (D9)', () => {
  const profileEmployment = [
    { company: 'Self-Employed', title: 'Product Engineer', start_date: '2023-08', end_date: null, pinned: true,
      bullets: ['Owner bullet one.', 'Owner bullet two', 'Owner bullet three', 'Owner bullet four', 'Owner bullet five'] },
    { company: 'Old Co', title: 'Engineer', start_date: '2018-01', end_date: '2020-01', bullets: ['Built things'] },
  ]

  it('emits the profile bullets verbatim, in order, over whatever the model returned, exempt from caps', () => {
    const out = normalizeResumeFormat(resume({
      employment: [{ company: 'Self-Employed', title: 'Product Engineer', start_date: '2023-08', end_date: null, bullets: ['Model rewrite'] }],
    }), profileEmployment)
    assert.deepEqual(out.employment[0].bullets, profileEmployment[0].bullets)
    assert.equal(out.employment[0].pinned, true)
  })

  it('restores a pinned entry the model dropped', () => {
    const out = normalizeResumeFormat(resume({ employment: [job('Old Co', '2018-01', 1)] }), profileEmployment)
    assert.deepEqual(out.employment.map((e) => e.company), ['Self-Employed', 'Old Co'])
  })
})

describe('isXyzBullet', () => {
  it('accepts a past-tense verb with a measurable result', () => {
    assert.ok(isXyzBullet('Cut p95 latency from 11.3s to 320ms by adding two-layer caching'))
    assert.ok(isXyzBullet('Raised test coverage from 50% to 80% using Jest'))
    assert.ok(isXyzBullet('Reduced open npm vulnerabilities to zero through dependency updates'))
  })
  it('accepts a past-tense verb with a non-numeric outcome, no method word needed', () => {
    assert.ok(isXyzBullet('Integrated Active Directory to make staff searchable, replacing phone directories'))
    assert.ok(isXyzBullet('Introduced feature flags, enabling staged production rollouts'))
    assert.ok(isXyzBullet('Built a query interface so power users could search inventory without learning SQL'))
    assert.ok(isXyzBullet('Developed dashboards used by every regional team'))
  })
  it('rejects duty-only, present-tense and verbless bullets', () => {
    assert.ok(!isXyzBullet('Built responsive UI using React'))
    assert.ok(!isXyzBullet('Functions as sole engineer, reducing costs by automating deploys'))
    assert.ok(!isXyzBullet('Sole engineer on a SaaS platform'))
  })
  it('does not treat incidental digits as a result', () => {
    assert.ok(!isXyzBullet('Automated Section 508 testing using Jest and Playwright'))
    assert.ok(!isXyzBullet('Launched v1 with authenticated REST APIs'))
    assert.ok(!isXyzBullet('Refactored the Drupal 8 theme into modular Sass'))
  })
})

describe('STAR/XYZ rule (Rule 5)', () => {
  const jd = 'Senior Product Engineer to build TypeScript services.'
  const base = () => resume({
    employment: [
      { company: 'Self-Employed', title: 'Product Engineer', start_date: '2023-08', end_date: null, pinned: true, bullets: ['Owned the product cycle'] },
      { ...job('Co', '2020-01', 0), bullets: ['Cut latency from 11s to 1s by caching responses', 'Built a dashboard'] },
    ],
    projects: [{ name: 'P', slug: 'p', highlights: ['Wrote docs'] }] as unknown as ResumeResponse['projects'],
  })
  const rule5 = (r: ResumeResponse) => scoreResume(r, jd).rules.find((x) => x.rule === 5)!

  it('is listed second, after the summary-title rule', () => {
    assert.equal(scoreResume(base(), jd).rules[1].rule, 5)
  })

  it('never changes when pinned bullets or project highlights change', () => {
    const a = rule5(base())
    const b = base()
    b.employment[0].bullets = ['Reduced costs from 9 to 1 by consolidating using a queue']
    b.projects[0].highlights = ['Cut build time from 60s to 5s by caching with Turbo']
    assert.equal(rule5(b).score, a.score)
  })
})

describe('pass threshold', () => {

  it('keeps the 4.0-of-5 ratio across the scored rules', () => {
    const rules = scoreResume(resume(), 'Engineer').rules.length
    assert.ok(Math.abs(PASS_THRESHOLD / rules - 4.0 / 5) < 1e-9, `${PASS_THRESHOLD}/${rules} should equal 4.0/5`)
  })
})
