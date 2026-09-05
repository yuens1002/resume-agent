/**
 * Unit tests — deterministic publication citation normalization
 * (src/lib/publication-citations.ts, #177 chunk 2).
 *
 * ACs: docs/plans/publication-citations-ACs.md
 *
 * Every fixture is invented here. No test pins the live profile's real slug,
 * title, or URL — seeding a second publication, or renaming the first, must
 * not be able to turn these green-but-wrong.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  citedPublications,
  normalizePublicationSourceLines,
  normalizePublicationSourcePaths,
} from '../src/lib/publication-citations.js'
import type { Publication } from '../src/types.js'

const pub = (slug: string, overrides: Partial<Publication> = {}): Publication => ({
  title: `Title for ${slug}`,
  slug,
  platform: 'Dev.to',
  canonical_url: `https://example.test/${slug}`,
  date: '2026-01-01',
  tags: ['testing'],
  grounded_in: 'some-concept',
  ...overrides,
})

const ONE = [pub('alpha-piece')]
const TWO = [pub('alpha-piece'), pub('beta-piece')]

const sourcesBlock = (...lines: string[]): string =>
  ['Some claim [1].', '', 'Sources:', ...lines].join('\n')

// ── AC-FN-1 / AC-FN-2: index-form resolution ─────────────
describe('AC-FN-1: index-form source entries resolve to the slug form', () => {
  it('rewrites publications[i] to the slug of that array element', () => {
    const out = normalizePublicationSourcePaths(['publications[1]'], '', TWO)
    assert.ok(out[0].startsWith(`publications.${TWO[1].slug}`), `got ${out[0]}`)
  })

  it('resolves index 0 to the first element, not merely to "some publication"', () => {
    const out = normalizePublicationSourcePaths(['publications[0]'], '', TWO)
    assert.ok(out[0].startsWith(`publications.${TWO[0].slug}`), `got ${out[0]}`)
  })

  it('normalizes the prose Sources block, leaving other source lines byte-identical', () => {
    const answer = sourcesBlock('[1] publications[0]', '[2] projects.some-project', '[3] skills.languages')
    const out = normalizePublicationSourceLines(answer, ONE)
    assert.ok(out.includes(`publications.${ONE[0].slug}`))
    assert.ok(out.includes('[2] projects.some-project'))
    assert.ok(out.includes('[3] skills.languages'))
  })
})

describe('AC-FN-2: out-of-range and malformed index forms are left alone', () => {
  for (const path of ['publications[5]', 'publications[-1]', 'publications[x]', 'publications[]']) {
    it(`returns ${path} unchanged`, () => {
      assert.deepEqual(normalizePublicationSourcePaths([path], '', ONE), [path])
    })
  }

  it('leaves an out-of-range prose source line exactly as written', () => {
    const answer = sourcesBlock('[1] publications[9]')
    assert.equal(normalizePublicationSourceLines(answer, ONE), answer)
  })

  it('never treats a lookalike token as a citation path', () => {
    const paths = ['publications_wishlist', 'my.publications', 'projects.publications-guide']
    assert.deepEqual(normalizePublicationSourcePaths(paths, '', ONE), paths)
  })
})

// ── AC-FN-3 / AC-FN-4: sub-paths vs whole-record citations ──
describe('AC-FN-3: sub-path citations keep their field and take no URL', () => {
  it('rewrites the collection segment but preserves the field suffix', () => {
    const [out] = normalizePublicationSourcePaths(['publications[0].grounded_in'], '', ONE)
    assert.equal(out, `publications.${ONE[0].slug}.grounded_in`)
  })

  it('does not append canonical_url to a sub-path citation', () => {
    const [out] = normalizePublicationSourcePaths(['publications[0].grounded_in'], '', ONE)
    assert.ok(!out.includes(ONE[0].canonical_url), `sub-path citation should carry no URL, got ${out}`)
  })
})

describe('AC-FN-4: whole-record citations carry the canonical URL in the prose block', () => {
  it('appends the profile record canonical_url to the prose Sources line', () => {
    const out = normalizePublicationSourceLines(sourcesBlock('[1] publications[0]'), ONE)
    assert.ok(out.includes(ONE[0].canonical_url), `got ${out}`)
  })

  it('omits the URL rather than emitting a dangling separator when the record has none', () => {
    const noUrl = [pub('no-url', { canonical_url: '' })]
    const out = normalizePublicationSourceLines(sourcesBlock('[1] publications[0]'), noUrl)
    assert.ok(out.includes('[1] publications.no-url'))
    assert.ok(!out.includes('—'), `no dangling separator, got ${out}`)
  })

  it('keeps the URL out of the machine-readable sources array — it belongs in the envelope', () => {
    const [out] = normalizePublicationSourcePaths(['publications[0]'], '', ONE)
    assert.equal(out, `publications.${ONE[0].slug}`)
    assert.ok(!out.includes(ONE[0].canonical_url), 'a corpus path is not a place to glue a URL onto')
  })
})

// ── AC-FN-5 / AC-FN-6: bare-collection resolution ────────
describe('AC-FN-5: bare `publications` resolves only when unambiguous', () => {
  it('resolves to the only publication when the profile has exactly one', () => {
    const [out] = normalizePublicationSourcePaths(['publications'], '', ONE)
    assert.ok(out.startsWith(`publications.${ONE[0].slug}`), `got ${out}`)
  })

  it('leaves the entry unchanged when several exist and the answer names none', () => {
    assert.deepEqual(
      normalizePublicationSourcePaths(['publications'], 'A vague answer naming nothing.', TWO),
      ['publications'],
    )
  })
})

describe('AC-FN-6: answer-mention matching resolves the right piece among several', () => {
  it('resolves by title mention, not by array position', () => {
    const answer = `The candidate wrote ${TWO[1].title} last spring.`
    const [out] = normalizePublicationSourcePaths(['publications'], answer, TWO)
    assert.ok(out.startsWith(`publications.${TWO[1].slug}`), `got ${out}`)
  })

  it('resolves by canonical_url mention', () => {
    const answer = `Read it at ${TWO[1].canonical_url}.`
    const [out] = normalizePublicationSourcePaths(['publications'], answer, TWO)
    assert.ok(out.startsWith(`publications.${TWO[1].slug}`), `got ${out}`)
  })

  it('refuses to choose when the answer mentions more than one', () => {
    const answer = `${TWO[0].title} and ${TWO[1].title} both cover this.`
    assert.deepEqual(normalizePublicationSourcePaths(['publications'], answer, TWO), ['publications'])
  })
})

// ── AC-FN-7: idempotence ─────────────────────────────────
describe('AC-FN-7: already-canonical entries are idempotent', () => {
  it('normalizing an already-normalized sources array is a no-op', () => {
    const once = normalizePublicationSourcePaths(['publications[0]'], '', ONE)
    assert.deepEqual(normalizePublicationSourcePaths(once, '', ONE), once)
  })

  it('normalizing an already-normalized answer is a no-op', () => {
    const answer = sourcesBlock('[1] publications[0]')
    const once = normalizePublicationSourceLines(answer, ONE)
    assert.equal(normalizePublicationSourceLines(once, ONE), once)
  })

  it('passes a compliant publications.<slug> path through unchanged', () => {
    const path = `publications.${ONE[0].slug}`
    assert.deepEqual(normalizePublicationSourcePaths([path], '', ONE), [path])
  })

  it('leaves a slug that matches no record untouched', () => {
    assert.deepEqual(
      normalizePublicationSourcePaths(['publications.not-a-real-slug'], '', ONE),
      ['publications.not-a-real-slug'],
    )
  })
})

// ── AC-FN-8: malformed input safety ──────────────────────
describe('AC-FN-8: malformed publication records never throw', () => {
  const junk = [null, 'not-an-object', 42, {}, { title: 'no slug' }, pub('good-one')] as unknown

  it('skips unusable records and still resolves the usable one', () => {
    const [out] = normalizePublicationSourcePaths(['publications'], '', junk)
    assert.ok(out.startsWith('publications.good-one'), `got ${out}`)
  })

  it('tolerates a non-array publications field', () => {
    for (const bad of [undefined, null, 'nope', 7, {}]) {
      assert.deepEqual(normalizePublicationSourcePaths(['publications[0]'], '', bad), ['publications[0]'])
      assert.equal(normalizePublicationSourceLines('Sources:\n[1] publications[0]', bad), 'Sources:\n[1] publications[0]')
      assert.deepEqual(citedPublications('answer', ['publications'], bad), [])
    }
  })

  it('returns a non-array sources field unchanged rather than inventing one', () => {
    assert.equal(normalizePublicationSourcePaths(undefined as unknown as string[], '', ONE), undefined)
    assert.equal(normalizePublicationSourcePaths('publications' as unknown as string[], '', ONE), 'publications')
  })
})

// ── Verification-sourced regressions (Phase 3, #177) ─────
// Each of these fails against the first draft of publication-citations.ts.
// They are the reason the module was rewritten: the original tests were shaped
// so that every one of these bugs stayed green.
describe('regression: an index must never slide onto a neighbouring record', () => {
  // The first draft filtered unusable records out and THEN indexed the
  // filtered array, so one malformed row earlier in the list shifted every
  // index and the resolver confidently emitted a different publication.
  const WITH_LEGACY_ROW = [{ title: 'legacy row, no slug' }, pub('beta-piece')] as unknown

  it('does not resolve an index pointing at a malformed record', () => {
    assert.deepEqual(normalizePublicationSourcePaths(['publications[0]'], '', WITH_LEGACY_ROW), ['publications[0]'])
  })

  it('still resolves a later index to the record actually at that position', () => {
    const [out] = normalizePublicationSourcePaths(['publications[1]'], '', WITH_LEGACY_ROW)
    assert.equal(out, 'publications.beta-piece')
  })

  it('never emits a slug the model did not point at', () => {
    const cited = citedPublications('', ['publications[0]'], WITH_LEGACY_ROW)
    assert.deepEqual(cited, [], 'a malformed row must yield no citation, not its neighbour')
  })
})

describe('regression: the word "publications" in prose is not a citation', () => {
  it('does not populate the envelope from an ordinary sentence', () => {
    assert.deepEqual(citedPublications('The candidate has a few publications.', [], ONE), [])
  })

  it('does not rewrite a numbered list in the answer body', () => {
    const answer = ['The list is:', '[1] publications', 'and that is all.'].join('\n')
    assert.equal(normalizePublicationSourceLines(answer, ONE), answer)
  })

  it('still populates the envelope from a real Sources block', () => {
    const cited = citedPublications(sourcesBlock('[1] publications[0]'), [], ONE)
    assert.equal(cited.length, 1)
    assert.equal(cited[0].slug, ONE[0].slug)
  })
})

describe('regression: the prose rewrite preserves surrounding whitespace', () => {
  it('does not eat the blank line after the Sources block', () => {
    const answer = ['Claim [1].', '', 'Sources:', '[1] publications[0]', '', '(Ask me anything else.)'].join('\n')
    const out = normalizePublicationSourceLines(answer, ONE)
    assert.ok(out.includes('\n\n(Ask me anything else.)'), `blank line destroyed: ${JSON.stringify(out)}`)
  })

  it('preserves a trailing newline at the end of the answer', () => {
    const answer = sourcesBlock('[1] publications[0]') + '\n'
    assert.ok(normalizePublicationSourceLines(answer, ONE).endsWith('\n'))
  })

  it('leaves everything above the Sources block byte-identical', () => {
    const head = 'A claim [1]. Another sentence mentioning publications in passing.'
    const answer = [head, '', 'Sources:', '[1] publications[0]'].join('\n')
    assert.ok(normalizePublicationSourceLines(answer, ONE).startsWith(head))
  })
})

// ── AC-FN-10: sources array contract ─────────────────────
describe('AC-FN-10: the JSON sources array is normalized in both styles', () => {
  it('preserves non-publication paths in their original order', () => {
    const out = normalizePublicationSourcePaths(
      ['experience.acme', 'publications[0]', 'skills.languages'],
      '',
      ONE,
    )
    assert.equal(out[0], 'experience.acme')
    assert.equal(out[2], 'skills.languages')
  })

  it('collapses two entries that normalize onto the same publication', () => {
    const out = normalizePublicationSourcePaths(['publications', 'publications[0]'], '', ONE)
    assert.equal(out.length, 1)
  })

  it('passes non-string entries through untouched instead of quietly validating an unrelated field', () => {
    const input = ['experience.acme', null, 7] as unknown as string[]
    assert.deepEqual(normalizePublicationSourcePaths(input, '', ONE), input)
  })

  it('does not dedupe non-publication paths — duplicates there are the model’s business', () => {
    const input = ['skills.a', 'skills.a', 'projects.b']
    assert.deepEqual(normalizePublicationSourcePaths(input, '', ONE), input)
  })

  it('leaves the array untouched when the profile has no publications at all', () => {
    const input = ['skills.a', 'skills.a', 'publications[0]']
    assert.deepEqual(normalizePublicationSourcePaths(input, '', []), input)
  })
})

// ── AC-FN-11 / AC-FN-12: envelope citations ──────────────
describe('AC-FN-11: the envelope carries machine-readable citations', () => {
  it('reads every field from the profile record, not the model text', () => {
    const answer = 'The candidate published something [1].\n\nSources:\n[1] publications[0]'
    const [citation] = citedPublications(answer, ['publications[0]'], ONE)
    assert.deepEqual(citation, {
      slug: ONE[0].slug,
      title: ONE[0].title,
      platform: ONE[0].platform,
      canonical_url: ONE[0].canonical_url,
      date: ONE[0].date,
    })
  })

  it('picks up a citation that appears only in the prose Sources block', () => {
    const answer = sourcesBlock('[1] publications[1]')
    const cited = citedPublications(answer, [], TWO)
    assert.equal(cited.length, 1)
    assert.equal(cited[0].slug, TWO[1].slug)
  })

  it('lists each cited publication once, even when cited by several paths', () => {
    const cited = citedPublications('', ['publications[0]', 'publications[0].grounded_in'], ONE)
    assert.equal(cited.length, 1)
  })
})

describe('AC-FN-12: the envelope field is absent-safe and quiet', () => {
  it('is empty when the answer cites no publication', () => {
    assert.deepEqual(citedPublications('A plain answer about projects.', ['projects.some-project'], ONE), [])
  })

  it('is empty when the profile has no publications at all', () => {
    assert.deepEqual(citedPublications('anything', ['publications[0]'], []), [])
  })

  it('does not resolve an ambiguous bare citation into a guess', () => {
    assert.deepEqual(citedPublications('A vague answer.', ['publications'], TWO), [])
  })
})
