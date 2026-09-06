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
    // Exact equality, not `includes`: an `includes` assertion still passes if
    // the projects line gained a suffix or the marker was rewritten, and the
    // ` — ` separator is the contract that makes a normalized line re-parse.
    assert.equal(
      normalizePublicationSourceLines(answer, ONE),
      sourcesBlock(
        `[1] publications.${ONE[0].slug} — ${ONE[0].canonical_url}`,
        '[2] projects.some-project',
        '[3] skills.languages',
      ),
    )
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
describe('AC-FN-3: sub-path citations keep their field; the array surface carries no URL', () => {
  it('rewrites the collection segment but preserves the field suffix', () => {
    const [out] = normalizePublicationSourcePaths(['publications[0].grounded_in'], '', ONE)
    assert.equal(out, `publications.${ONE[0].slug}.grounded_in`)
  })

  it('does not append canonical_url to a sub-path citation', () => {
    const [out] = normalizePublicationSourcePaths(['publications[0].grounded_in'], '', ONE)
    assert.ok(!out.includes(ONE[0].canonical_url), `sub-path citation should carry no URL, got ${out}`)
  })

  // The link is emitted once per publication, on its first line. Live probing
  // found the model citing only field sub-paths (`.title`, `.date`) for a
  // "where can I read it" question — a rule that suppressed the URL on every
  // sub-path line left the reader with no link at all.
  it('puts the link on a sub-path line when that is the first line citing the piece', () => {
    assert.equal(
      normalizePublicationSourceLines(sourcesBlock('[1] publications[0].grounded_in'), ONE),
      sourcesBlock(`[1] publications.${ONE[0].slug}.grounded_in — ${ONE[0].canonical_url}`),
    )
  })

  it('emits the link exactly once across several lines citing the same piece', () => {
    const out = normalizePublicationSourceLines(
      sourcesBlock('[1] publications[0].title', '[2] publications[0].date', '[3] publications[0].grounded_in'),
      ONE,
    )
    assert.equal(out.split(ONE[0].canonical_url).length - 1, 1, `expected exactly one link, got: ${out}`)
    assert.ok(out.includes(`[1] publications.${ONE[0].slug}.title — ${ONE[0].canonical_url}`))
    assert.ok(out.includes(`[3] publications.${ONE[0].slug}.grounded_in`))
  })

  it('gives each cited publication its own link', () => {
    const out = normalizePublicationSourceLines(sourcesBlock('[1] publications[0]', '[2] publications[1]'), TWO)
    assert.ok(out.includes(TWO[0].canonical_url))
    assert.ok(out.includes(TWO[1].canonical_url))
  })

  it('never leaves a cited publication without a link when the record has one', () => {
    const out = normalizePublicationSourceLines(sourcesBlock('[1] publications[0].date'), ONE)
    assert.ok(out.includes(ONE[0].canonical_url), 'a sub-path-only citation must still reach the reader with a link')
  })
})

describe('AC-FN-4: whole-record citations carry the canonical URL in the prose block', () => {
  it('appends the profile record canonical_url to the prose Sources line, separated by an em dash', () => {
    assert.equal(
      normalizePublicationSourceLines(sourcesBlock('[1] publications[0]'), ONE),
      sourcesBlock(`[1] publications.${ONE[0].slug} — ${ONE[0].canonical_url}`),
    )
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

  // `sources` is declared `string[]` on QueryResponse and in the OpenAPI
  // schema, but reaches here unvalidated from parseJSON. Enforce the declared
  // type — eval-query-answer.ts calls .toLowerCase() on every entry.
  it('returns a real string[] when the model emitted something else entirely', () => {
    assert.deepEqual(normalizePublicationSourcePaths(undefined as unknown as string[], '', ONE), [])
    assert.deepEqual(normalizePublicationSourcePaths('publications' as unknown as string[], '', ONE), [])
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

// ── OCR-review-sourced regressions (Phase 4.4, #177) ─────
// Each of these survived the previous suite: the reviewer mutation-tested the
// implementation and these mutations went undetected. They are the gaps, not
// the coverage.
describe('regression: only lines inside the Sources block are rewritten', () => {
  it('leaves a citation-shaped line in the answer body alone when a real block follows', () => {
    const answer = [
      'Some prose.',
      '[1] publications[0]',
      'More prose.',
      '',
      'Sources:',
      '[1] publications[0]',
    ].join('\n')
    const out = normalizePublicationSourceLines(answer, ONE)
    const lines = out.split('\n')
    assert.equal(lines[1], '[1] publications[0]', 'the body line must be byte-identical')
    assert.equal(lines[5], `[1] publications.${ONE[0].slug} — ${ONE[0].canonical_url}`)
  })

  it('rewrites every publication line in the block, not just the first', () => {
    const answer = sourcesBlock('[1] publications[0]', '[2] publications[1]')
    const out = normalizePublicationSourceLines(answer, TWO)
    assert.ok(out.includes(`[1] publications.${TWO[0].slug}`))
    assert.ok(out.includes(`[2] publications.${TWO[1].slug}`))
  })
})

describe('regression: a short or generic title must not resolve by prose mention', () => {
  // `upsert_publication` takes an unvalidated string title, so a piece can be
  // titled "AI" — which a bare substring test finds inside "maintain".
  const SHORT_TITLE = [pub('short-one', { title: 'AI' }), pub('other-one', { title: 'Something Else Entirely' })]

  it('does not match a two-letter title inside an ordinary word', () => {
    assert.deepEqual(
      normalizePublicationSourcePaths(['publications'], 'The candidate helps maintain good habits.', SHORT_TITLE),
      ['publications'],
    )
  })

  it('does not match a long title inside a longer word', () => {
    const embedded = [pub('a-piece', { title: 'Evaluation' }), pub('b-piece')]
    assert.deepEqual(
      normalizePublicationSourcePaths(['publications'], 'Work on Evaluations and benchmarks.', embedded),
      ['publications'],
    )
  })

  it('still matches a distinctive title regardless of case', () => {
    const [out] = normalizePublicationSourcePaths(['publications'], `Read ${TWO[1].title.toUpperCase()} today.`, TWO)
    assert.equal(out, `publications.${TWO[1].slug}`)
  })

  it('still resolves by canonical_url when the title is too short to match', () => {
    const [out] = normalizePublicationSourcePaths(['publications'], `See ${SHORT_TITLE[0].canonical_url} for it.`, SHORT_TITLE)
    assert.equal(out, 'publications.short-one')
  })
})

describe('regression: an index the prose contradicts is refused', () => {
  // A model may number `publications[1]` to mirror its own `[1]` marker. With
  // one publication that is harmlessly out of range; with two it would cite
  // the wrong piece.
  it('refuses an index pointing at a piece the answer does not name', () => {
    const answer = `The candidate wrote ${TWO[0].title} last spring.`
    assert.deepEqual(normalizePublicationSourcePaths(['publications[1]'], answer, TWO), ['publications[1]'])
  })

  it('accepts the index when the answer names that same piece', () => {
    const answer = `The candidate wrote ${TWO[1].title} last spring.`
    assert.deepEqual(normalizePublicationSourcePaths(['publications[1]'], answer, TWO), [`publications.${TWO[1].slug}`])
  })

  it('accepts the index when the answer names nothing at all', () => {
    assert.deepEqual(normalizePublicationSourcePaths(['publications[1]'], 'A vague answer.', TWO), [`publications.${TWO[1].slug}`])
  })
})

describe('regression: the two-pass composition query.ts relies on', () => {
  // query.ts runs the prose pass first and feeds its output to the array pass,
  // so a bare `publications` on a multi-publication profile resolves to the
  // piece the answer's own Sources block cited. Swapping the two calls
  // regresses this; nothing else pins it.
  it('resolves a bare sources entry against the prose pass output', () => {
    const answer = sourcesBlock('[1] publications[1]')
    const normalizedAnswer = normalizePublicationSourceLines(answer, TWO)
    assert.deepEqual(
      normalizePublicationSourcePaths(['publications'], normalizedAnswer, TWO),
      [`publications.${TWO[1].slug}`],
    )
  })

  it('is ambiguous — and so refuses — when the prose cited both pieces', () => {
    const answer = sourcesBlock('[1] publications[0]', '[2] publications[1]')
    const normalizedAnswer = normalizePublicationSourceLines(answer, TWO)
    assert.deepEqual(normalizePublicationSourcePaths(['publications'], normalizedAnswer, TWO), ['publications'])
  })

  it('reports the envelope in citation order of first appearance', () => {
    const answer = sourcesBlock('[1] publications[1]', '[2] publications[0]')
    const cited = citedPublications(normalizePublicationSourceLines(answer, TWO), [], TWO)
    assert.deepEqual(cited.map((c) => c.slug), [TWO[1].slug, TWO[0].slug])
  })
})

// ── Low-severity findings from Phase 4.4, fixed at owner request ──
describe('a slug containing a dot is not mis-split into slug + sub-path', () => {
  // Nothing constrains a slug to exclude `.` — upsert_publication takes a bare
  // string — so `publications.a.b` is ambiguous until resolution settles it.
  const NESTED = [pub('a'), pub('a.b')]

  // No test asserts the normalized *path string* for the nested case: slug `a`
  // + sub-path `.b` and slug `a.b` + no sub-path both render as
  // `publications.a.b`, so a string assertion passes either way. The
  // difference is only observable in which record was resolved — which is what
  // the two tests below check.
  it('reports the longest-matching record in the envelope, not its shorter prefix', () => {
    const cited = citedPublications('', ['publications.a.b'], NESTED)
    assert.deepEqual(cited.map((c) => c.slug), ['a.b'])
  })

  it('still treats a trailing segment as a sub-path when no longer slug exists', () => {
    assert.deepEqual(
      normalizePublicationSourcePaths(['publications.a.grounded_in'], '', [pub('a')]),
      ['publications.a.grounded_in'],
    )
  })

  it('links the longest-matching record in the prose block', () => {
    const out = normalizePublicationSourceLines(sourcesBlock('[1] publications.a.b'), NESTED)
    assert.equal(out, sourcesBlock('[1] publications.a.b — ' + NESTED[1].canonical_url))
  })
})

describe('non-string record fields are coerced, not forwarded', () => {
  // isCitable validates only `slug`; the rest is owner-supplied JSONB.
  const MALFORMED = [{ slug: 'weird', title: 42, platform: null, canonical_url: { u: 1 }, date: [] }] as unknown

  it('emits strings for every declared-string field', () => {
    const [citation] = citedPublications('', ['publications[0]'], MALFORMED)
    assert.equal(typeof citation.title, 'string')
    assert.equal(typeof citation.platform, 'string')
    assert.equal(typeof citation.canonical_url, 'string')
    assert.equal(typeof citation.date, 'string')
  })

  it('still identifies the record by its valid slug', () => {
    assert.deepEqual(citedPublications('', ['publications[0]'], MALFORMED).map((c) => c.slug), ['weird'])
  })

  it('emits no dangling separator when canonical_url is not a string', () => {
    const out = normalizePublicationSourceLines(sourcesBlock('[1] publications[0]'), MALFORMED)
    assert.equal(out, sourcesBlock('[1] publications.weird'))
  })
})

describe('the Sources heading is as tolerant as its siblings', () => {
  // parse-json.ts and eval-query-answer.ts both accept looser headings; a
  // stricter pattern here would silently no-op and leave the raw form.
  it('normalizes under a bold heading', () => {
    const answer = ['Claim [1].', '', '**Sources:**', '[1] publications[0]'].join('\n')
    assert.ok(normalizePublicationSourceLines(answer, ONE).includes('publications.' + ONE[0].slug))
  })

  // Boundary, asserted deliberately rather than left to chance: a citation
  // sharing the heading's line is a no-op. parse-json.ts's salvage requires
  // `Sources:` followed by a newline, and RULE_CITATION says one source per
  // line, so nothing else in this repo parses that shape either — supporting
  // it only here would make this module the odd one out.
  it('leaves a citation sharing the heading line alone, matching parse-json.ts', () => {
    const answer = ['Claim [1].', '', 'Sources: [1] publications[0]'].join('\n')
    assert.equal(normalizePublicationSourceLines(answer, ONE), answer)
  })

  it('still rewrites nothing when there is no heading at all', () => {
    const answer = ['Claim [1].', '[1] publications[0]'].join('\n')
    assert.equal(normalizePublicationSourceLines(answer, ONE), answer)
  })
})

describe('duplicates are collapsed only among entries this module rewrote', () => {
  it('collapses two forms that normalize onto the same path', () => {
    assert.deepEqual(normalizePublicationSourcePaths(['publications[0]', 'publications'], '', ONE), [
      'publications.' + ONE[0].slug,
    ])
  })

  it('leaves duplicate unresolved publication entries exactly as written', () => {
    const input = ['publications[9]', 'publications[9]']
    assert.deepEqual(normalizePublicationSourcePaths(input, '', ONE), input)
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

  it('drops non-string entries, which the declared string[] contract says cannot exist', () => {
    const input = ['experience.acme', null, 7, 'skills.a'] as unknown as string[]
    assert.deepEqual(normalizePublicationSourcePaths(input, '', ONE), ['experience.acme', 'skills.a'])
  })

  it('every returned entry is a string, even when the profile has no publications', () => {
    const input = ['experience.acme', null, 7] as unknown as string[]
    for (const entry of normalizePublicationSourcePaths(input, '', [])) {
      assert.equal(typeof entry, 'string')
    }
  })

  it('does not dedupe non-publication paths — duplicates there are the model’s business', () => {
    const input = ['skills.a', 'skills.a', 'projects.b']
    assert.deepEqual(normalizePublicationSourcePaths(input, '', ONE), input)
  })

  it('leaves string entries untouched, in order, when the profile has no publications at all', () => {
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
