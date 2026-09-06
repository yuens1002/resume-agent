/**
 * Unit tests — streaming publication citation normalization
 * (createStreamingSourcesNormalizer / normalizePublicationSourcesStream in
 * src/lib/publication-citations.ts, #251).
 *
 * The whole contract is one property, and AC-3/AC-10 assert it directly:
 * for ANY chunking of ANY input, the streamed output equals what the
 * non-streaming path would have produced. Everything else here is a named
 * case of that property, kept separate so a failure says which behavior broke.
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
  createStreamingSourcesNormalizer,
  normalizePublicationSourceLines,
  normalizePublicationSourcesStream,
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

/** Drive the normalizer over one specific chunking and return the full output. */
function runChunks(chunks: string[], publications: unknown): string {
  const normalizer = createStreamingSourcesNormalizer(publications)
  let out = ''
  for (const chunk of chunks) out += normalizer.push(chunk)
  out += normalizer.flush()
  return out
}

/** The answer the non-streaming path would have produced — the reference for every case. */
const reference = (text: string, publications: unknown): string =>
  normalizePublicationSourceLines(text, publications)

/**
 * Assert the property at every possible chunk boundary, plus the degenerate
 * chunking of one chunk per character. A boundary-sensitivity bug survives a
 * hand-picked split; it does not survive this.
 */
function assertChunkingInvariant(text: string, publications: unknown): void {
  const expected = reference(text, publications)
  for (let i = 0; i <= text.length; i += 1) {
    const chunks = [text.slice(0, i), text.slice(i)]
    assert.equal(runChunks(chunks, publications), expected, `split at index ${i}`)
  }
  assert.equal(runChunks([...text], publications), expected, 'one chunk per character')
}

/** Pump the TransformStream adapter, which is what the two route call sites actually use. */
async function runTransform(chunks: string[], publications: unknown): Promise<string> {
  const transform = normalizePublicationSourcesStream(publications)
  const collecting = (async () => {
    const reader = transform.readable.getReader()
    let out = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return out
      out += value
    }
  })()
  const writer = transform.writable.getWriter()
  for (const chunk of chunks) await writer.write(chunk)
  await writer.close()
  return collecting
}

describe('AC-1: a whole answer in one chunk matches the non-streaming normalizer', () => {
  it('rewrites the publication line and leaves other source lines byte-identical', () => {
    const answer = sourcesBlock('[1] publications[0]', '[2] projects.some-project', '[3] skills.languages')
    // Exact equality against a literal, not just against the reference helper:
    // if both paths regressed the same way, comparing them to each other would
    // still pass. This pins the shape the streamed footer must actually have.
    assert.equal(
      runChunks([answer], ONE),
      sourcesBlock(
        `[1] publications.${ONE[0].slug} — ${ONE[0].canonical_url}`,
        '[2] projects.some-project',
        '[3] skills.languages',
      ),
    )
  })

  it('agrees with normalizePublicationSourceLines on the same input', () => {
    const answer = sourcesBlock('[1] publications[0]', '[2] projects.some-project')
    assert.equal(runChunks([answer], ONE), reference(answer, ONE))
  })
})

describe('AC-2: a marker straddling a chunk boundary is still detected', () => {
  const answer = sourcesBlock('[1] publications[0]')
  const expected = reference(answer, ONE)

  it('splits inside the word Sources', () => {
    const at = answer.indexOf('Sources:') + 4 // …\nSour | ces:…
    assert.equal(runChunks([answer.slice(0, at), answer.slice(at)], ONE), expected)
  })

  it('splits immediately after the newline that opens the Sources line', () => {
    const at = answer.indexOf('Sources:')
    assert.equal(runChunks([answer.slice(0, at), answer.slice(at)], ONE), expected)
  })

  it('splits between the bold delimiter and the word', () => {
    const bold = ['Some claim [1].', '', '**Sources:**', '[1] publications[0]'].join('\n')
    const at = bold.indexOf('**Sources') + 2 // …\n** | Sources:**
    assert.equal(runChunks([bold.slice(0, at), bold.slice(at)], ONE), reference(bold, ONE))
  })
})

describe('AC-3: the chunking invariant holds at every boundary', () => {
  it('single publication, mixed source lines', () => {
    assertChunkingInvariant(
      sourcesBlock('[1] publications[0]', '[2] projects.some-project', '[3] skills.languages'),
      ONE,
    )
  })

  it('two publications, index-form citation resolved against the raw array', () => {
    assertChunkingInvariant(sourcesBlock('[1] publications[1]'), TWO)
  })

  it('multi-line citation of the same publication — the URL appears once', () => {
    assertChunkingInvariant(
      sourcesBlock('[1] publications[0].title', '[2] publications[0].date'),
      ONE,
    )
  })

  it('an answer with no Sources block at all', () => {
    assertChunkingInvariant('Just prose about publications, with no citation markers.', ONE)
  })
})

describe('AC-4: an answer with no Sources block is passed through byte-identical', () => {
  it('returns the input unchanged across chunk boundaries', () => {
    const answer = 'He has written a few publications.\n\nNothing is cited here.'
    assert.equal(runChunks([answer], ONE), answer)
    assert.equal(runChunks([...answer], ONE), answer)
  })

  it('handles an empty stream', () => {
    assert.equal(runChunks([], ONE), '')
    assert.equal(runChunks([''], ONE), '')
  })
})

describe('AC-5: a profile with no publications is an identity pass-through', () => {
  it('releases every chunk immediately, holding nothing back', () => {
    const normalizer = createStreamingSourcesNormalizer([])
    // A chunk that ends mid-marker is exactly what the retention path would
    // hold. With nothing to normalize there is nothing to wait for, so a
    // change that cannot affect the output must not affect latency either.
    assert.equal(normalizer.push('Some claim [1].\n\nSour'), 'Some claim [1].\n\nSour')
    assert.equal(normalizer.push('ces:\n[1] publications[0]'), 'ces:\n[1] publications[0]')
    assert.equal(normalizer.flush(), '')
  })

  it('treats a missing or malformed publications field the same way', () => {
    const answer = sourcesBlock('[1] publications[0]')
    assert.equal(runChunks([...answer], undefined), answer)
    assert.equal(runChunks([...answer], { not: 'an array' }), answer)
  })
})

describe('AC-6: progressive rendering is preserved for everything above the footer', () => {
  it('releases the body before flush, and only holds the footer', () => {
    const normalizer = createStreamingSourcesNormalizer(ONE)
    const body = 'Some claim [1].\n\n'
    assert.equal(normalizer.push(body), body, 'body must be released as it arrives, not buffered')

    const footer = 'Sources:\n[1] publications[0]\n'
    assert.equal(normalizer.push(footer), '', 'the footer is held until the stream ends')
    assert.equal(
      normalizer.flush(),
      `Sources:\n[1] publications.${ONE[0].slug} — ${ONE[0].canonical_url}\n`,
    )
  })

  it('does not wait for a newline to release ordinary prose', () => {
    // Line-buffering would have been the easy way to handle straddled markers,
    // and would have made a paragraph-length sentence arrive all at once.
    const normalizer = createStreamingSourcesNormalizer(ONE)
    assert.equal(normalizer.push('The candidate '), 'The candidate ')
    assert.equal(normalizer.push('has written '), 'has written ')
  })
})

describe('AC-7: the bold Sources variant is recognized', () => {
  it('normalizes under **Sources:**', () => {
    const answer = ['Some claim [1].', '', '**Sources:**', '[1] publications[0]'].join('\n')
    assert.equal(
      runChunks([...answer], ONE),
      ['Some claim [1].', '', '**Sources:**', `[1] publications.${ONE[0].slug} — ${ONE[0].canonical_url}`].join('\n'),
    )
  })
})

describe('AC-8: nothing outside a publication source line is touched', () => {
  it('leaves prose, markers, and non-publication source lines byte-identical', () => {
    const answer = [
      'He shipped **Sources** for the pipeline [1], and wrote about it [2].',
      '',
      'Sources:',
      '[1] projects.pipeline',
      '[2] publications[0]',
      '[3] skills.languages   ',
    ].join('\n')
    const streamed = runChunks([...answer], ONE)
    assert.equal(streamed, reference(answer, ONE))
    assert.ok(streamed.includes('[1] projects.pipeline\n'))
    assert.ok(streamed.includes('[3] skills.languages   '))
  })
})

describe('AC-9: re-running over already-normalized text is idempotent', () => {
  it('does not append the URL twice', () => {
    const once = reference(sourcesBlock('[1] publications[0]'), ONE)
    assert.equal(runChunks([...once], ONE), once)
  })
})

describe('AC-10: the partial-marker guard stays in sync with the block regex', () => {
  // The retention rule is a hand-written prefix matcher for SOURCES_BLOCK_RE.
  // These are the marker forms that regex accepts; splitting each at every
  // index is what proves no prefix of one is released early.
  for (const marker of ['Sources:', '**Sources:**', '__Sources:__', '  Sources:', '\tSources:', '  **Sources:**']) {
    it(`holds every prefix of ${JSON.stringify(marker)}`, () => {
      assertChunkingInvariant(['Some claim [1].', '', marker, '[1] publications[0]'].join('\n'), ONE)
    })
  }
})

describe('AC-12: degenerate footers still match the non-streaming path exactly', () => {
  // Parity is the contract, including where the non-streaming normalizer
  // deliberately does nothing. A truncated stream is the live case worth
  // pinning: generateWithLengthRetry does not wrap the streaming path, so a
  // `finishReason: length` cut lands mid-footer with no retry behind it.
  const cases: Record<string, string> = {
    'truncated mid footer line': 'Claim [1].\n\nSources:\n[1] publications[0',
    'truncated immediately after the marker': 'Claim [1].\n\nSources:',
    'two Sources blocks — the first one wins, as it does off-stream':
      'Claim [1].\n\nSources:\n[1] publications[0]\n\nSources:\n[2] publications[0]',
    'the word Sources: opening a prose line':
      'Sources: are listed below.\n\nSources:\n[1] publications[0]',
    'marker at index 0': 'Sources:\n[1] publications[0]',
    'CRLF line endings': 'Claim [1].\r\n\r\nSources:\r\n[1] publications[0]\r\n',
  }

  for (const [name, text] of Object.entries(cases)) {
    it(name, () => {
      assert.equal(runChunks([...text], ONE), reference(text, ONE))
    })
  }
})

describe('AC-13: the incremental rescan does not invent a line start', () => {
  // The per-chunk scan is anchored to the enclosing line start rather than to
  // `emitted`, because SOURCES_BLOCK_RE's `^` matches the start of whatever
  // string it is handed. Slicing at `emitted` — the obvious optimization — lets
  // prose that merely resumes with the word "Sources:" after a mid-line release
  // look like a line-start match.
  //
  // Note what that does and does not break. The OUTPUT stays correct either
  // way: flush() re-normalizes the whole accumulated text with the real regex
  // and slices at `emitted`, so a false start earlier than the true footer
  // still lands in the untouched head. What breaks is release timing — a false
  // positive latches `holding` and buffers the entire rest of the answer to the
  // end of the stream. So these assert on when text is released, not just on
  // what comes out; a byte-equality test passes against the broken version.
  const prose = 'He wrote about '
  const resumes = 'Sources: are cited inline here, not in a block.'

  it('keeps releasing prose that resumes with the word "Sources:" mid-line', () => {
    const normalizer = createStreamingSourcesNormalizer(ONE)
    assert.equal(normalizer.push(prose), prose)
    assert.equal(
      normalizer.push(resumes),
      resumes,
      'a mid-line "Sources:" is not a footer — holding here would stall the rest of the answer',
    )
    assert.equal(normalizer.flush(), '')
  })

  it('produces byte-identical output for that answer at any chunk boundary', () => {
    const midLine = prose + resumes
    assertChunkingInvariant(midLine, ONE)
    assert.equal(runChunks([...midLine], ONE), midLine)
  })

  it('still finds a real footer that follows mid-line prose about sources', () => {
    const text = `${prose}${resumes}\n\nSources:\n[1] publications[0]`
    const streamed = runChunks([...text], ONE)
    assert.equal(streamed, reference(text, ONE))
    assert.ok(streamed.endsWith(`publications.${ONE[0].slug} — ${ONE[0].canonical_url}`))
  })
})

describe('AC-11: the TransformStream adapter matches the synchronous core', () => {
  it('normalizes across an arbitrary chunking', async () => {
    const answer = sourcesBlock('[1] publications[0]', '[2] projects.some-project')
    assert.equal(await runTransform([...answer], ONE), reference(answer, ONE))
  })

  it('emits nothing extra for a pass-through profile', async () => {
    const answer = sourcesBlock('[1] publications[0]')
    assert.equal(await runTransform([...answer], []), answer)
  })

  it('closes cleanly on an empty stream', async () => {
    assert.equal(await runTransform([], ONE), '')
  })
})
