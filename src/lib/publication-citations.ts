// Deterministic normalization of publication citations in a /query response.
//
// Publications reach the model the same way projects do — the whole profile
// row is stringified into the user message (see buildQueryPrompt) — so the
// model already cites them. What it does NOT do reliably is cite them in the
// documented form: live probes show `publications[0]` (array-index form,
// unstable across upserts and unresolvable by a consumer), a bare
// `publications` in the conversational `sources` array, and no `canonical_url`
// anywhere — even when the visitor explicitly asks where to read the piece,
// which is the whole point of #177.
//
// The obvious fix — naming `publications.<slug>` in RULE_CITATION — is exactly
// what got #177 chunk 2 parked on 2026-07-11: every wording tried displaced the
// overview-projects follow-up offer (11/11 runs, 4 variants). So this module
// does it after generation instead, on the same principle already applied to
// the #215 decline guard in src/routes/query.ts: enforce deterministically
// rather than editing a prompt with a history of displacing unrelated
// behavior. RULE_CITATION and RULE_CITATION_CONVERSATIONAL stay untouched and
// PROMPT_VERSION stays byte-identical to main.
//
// Two rules govern everything below, both learned from verification probes on
// the first draft of this module:
//
//   1. Never guess. An entry that cannot be resolved to exactly one
//      publication is returned exactly as the model wrote it. A confidently
//      wrong citation is worse than an unnormalized one, in a system whose
//      entire value proposition is verifiable evidence. The first draft
//      violated this by resolving array indices against a *filtered* copy of
//      the array: one malformed row earlier in the list shifted every index
//      and the resolver happily emitted a different publication's slug and
//      URL. Indices are now resolved against the raw array — the same one the
//      model was shown — and the resolved record is validated afterward.
//
//   2. Touch only what is unambiguously a citation. The first draft scanned
//      the whole answer for the bare word `publications`, so an ordinary
//      sentence ("he has a few publications") populated the envelope; and its
//      prose rewrite matched any `[N] publications` line anywhere in the
//      answer and ate the newline after it. Prose rewriting is now confined to
//      lines inside the `Sources:` block and preserves surrounding whitespace.
import type { Publication, PublicationCitation } from '../types.js'

export type { PublicationCitation }

/**
 * Source paths the model actually produces for publications, observed live:
 *   publications                      — bare collection (conversational sources[])
 *   publications[0]                   — array index (cited Sources: block)
 *   publications[0].grounded_in       — array index with a field sub-path
 *   publications.<slug>               — the documented form, when it complies
 *   publications.<slug>.grounded_in   — documented form with a sub-path
 * The leading token is anchored so `publications_wishlist` or a prose sentence
 * beginning with the word can never be mistaken for a citation path.
 */
const PUBLICATION_SOURCE_RE = /^publications(?:\[(-?\d+)\]|\.([A-Za-z0-9_-]+))?((?:\.[A-Za-z0-9_-]+)*)$/

/** The bare path shape, for embedding in the prose-line pattern below. */
const PUBLICATION_PATH_SOURCE = String.raw`publications(?:\[-?\d+\]|\.[A-Za-z0-9_-]+)?(?:\.[A-Za-z0-9_-]+)*`

/**
 * One line of a `Sources:` block citing a publication:
 *   `[1] publications[0]` or, once normalized, `[1] publications.slug — https://…`
 * Captures marker, path, any previously-appended URL suffix (so re-running is
 * idempotent), and trailing spaces. Deliberately uses `[ \t]` rather than `\s`
 * everywhere: `\s*$` under the `m` flag consumes the newline that ends the
 * line, and a replacement that doesn't re-emit it silently deletes blank lines
 * from the answer the visitor reads.
 */
const SOURCES_LINE_RE = new RegExp(
  String.raw`^([ \t]*\[\d+\][ \t]*)(${PUBLICATION_PATH_SOURCE})((?:[ \t]*—[ \t]*\S+)?)([ \t]*)$`,
  'gm',
)

/** Where the prose `Sources:` block begins. Nothing above it is ever rewritten. */
const SOURCES_BLOCK_RE = /^[ \t]*(?:\*\*|__)?Sources:(?:\*\*|__)?/m

/**
 * Every marker form SOURCES_BLOCK_RE accepts, as concrete strings.
 *
 * Exported so the tests iterate this instead of keeping their own hand-copied
 * list — the streaming suite is the only place the underscore, tab-indented and
 * indented-bold variants are covered at all.
 *
 * The guard this buys is one-directional, and worth stating precisely rather
 * than overclaiming: `AC-10` asserts every entry here IS accepted by
 * SOURCES_BLOCK_RE, so an entry that stops matching fails loudly. The reverse —
 * widening the regex without adding the form here — cannot be caught by
 * enumeration, since a list has no way to know what the regex now also accepts.
 * Adding a marker form means editing both.
 */
export const SOURCES_MARKER_FORMS = [
  'Sources:',
  '**Sources:**',
  '__Sources:__',
  '  Sources:',
  '\tSources:',
  '  **Sources:**',
] as const

interface ParsedSourcePath {
  /** Array index, when the entry used index form. */
  index?: number
  /** First path segment after `publications.`, when the entry used dotted form. */
  segment?: string
  /** Everything after the identifying segment, e.g. `.grounded_in`. Empty for whole-record citations. */
  subPath: string
}

/** Parse a source path if it addresses the publications collection; otherwise null. */
function parsePublicationSourcePath(path: string): ParsedSourcePath | null {
  const match = PUBLICATION_SOURCE_RE.exec(path.trim())
  if (!match) return null
  const [, indexText, segment, subPath] = match
  if (indexText !== undefined) return { index: Number(indexText), subPath: subPath ?? '' }
  if (segment !== undefined) return { segment, subPath: subPath ?? '' }
  return { subPath: subPath ?? '' }
}

/** A record is usable only if it can actually be cited — slug is the identity key. */
function isCitable(pub: unknown): pub is Publication {
  return (
    typeof pub === 'object' &&
    pub !== null &&
    typeof (pub as Publication).slug === 'string' &&
    (pub as Publication).slug.length > 0
  )
}

/**
 * The raw profile array, or an empty array when the field is missing or
 * malformed. Deliberately NOT filtered: positions here are the positions the
 * model saw, and index-form citations are only sound against those.
 */
function rawPublications(publications: unknown): unknown[] {
  return Array.isArray(publications) ? publications : []
}

/**
 * Shortest title that may be matched against answer prose. A title is
 * owner-supplied and unvalidated for length (`upsert_publication` takes a bare
 * string), so a piece titled "AI" or "Go" would otherwise match inside
 * ordinary words and resolve a citation to the wrong publication. Below this
 * floor, title matching is skipped entirely — `canonical_url` matching and the
 * single-publication fallback still apply, and refusing to resolve is always
 * the safe direction here.
 */
const MIN_TITLE_MATCH_LENGTH = 12

/** Does `haystack` contain `needle` as a whole token rather than inside a longer word? */
function containsAtWordBoundary(haystack: string, needle: string): boolean {
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx < 0) return false
    const before = idx === 0 ? '' : haystack[idx - 1]
    const after = haystack[idx + needle.length] ?? ''
    if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return true
    from = idx + 1
  }
}

/**
 * Find the single publication an answer is talking about, by looking for its
 * title or canonical_url in the prose. Returns null when zero or more than one
 * match — "more than one" is genuinely ambiguous and must not be resolved.
 *
 * Matching is case-insensitive, bounded at word boundaries, and floored at
 * MIN_TITLE_MATCH_LENGTH for titles: a bare substring test over owner-supplied
 * titles is the classic way a "match" turns into a wrong citation.
 */
function resolveByAnswerMention(answer: string, citable: Publication[]): Publication | null {
  const haystack = answer.toLowerCase()
  const mentioned = citable.filter((pub) => {
    const title =
      typeof pub.title === 'string' && pub.title.length >= MIN_TITLE_MATCH_LENGTH ? pub.title.toLowerCase() : null
    const url =
      typeof pub.canonical_url === 'string' && pub.canonical_url.length > 0 ? pub.canonical_url.toLowerCase() : null
    return (
      (title !== null && containsAtWordBoundary(haystack, title)) ||
      (url !== null && haystack.includes(url))
    )
  })
  return mentioned.length === 1 ? mentioned[0] : null
}

/**
 * Resolve one parsed source path to a publication record.
 *
 * Ordered most-specific-first. A bare `publications` falls back to the answer
 * text, and then to "there is only one publication, so it can only be that
 * one" — the common case for a profile that has just started publishing.
 */
interface ResolvedCitation {
  pub: Publication
  subPath: string
}

function resolveParsedPath(
  parsed: ParsedSourcePath,
  answer: string,
  raw: unknown[],
): ResolvedCitation | null {
  const citable = raw.filter(isCitable)
  if (parsed.index !== undefined) {
    // Indexed against the raw array — see rule 1 in the module header. The
    // resolved record is then validated, so an index pointing at a malformed
    // row yields nothing rather than silently sliding onto its neighbour.
    if (!Number.isInteger(parsed.index) || parsed.index < 0 || parsed.index >= raw.length) return null
    const record = raw[parsed.index]
    if (!isCitable(record)) return null
    // The index is assumed 0-based, but nothing makes the model agree: it may
    // number `publications[1]` to mirror its own `[1]` marker. With a single
    // publication a 1-based index is harmlessly out of range; with two or more
    // it would resolve confidently to the wrong piece. So when the answer
    // unambiguously names a different publication than the index points at,
    // trust the prose and refuse rather than emit a citation the text
    // contradicts.
    const named = resolveByAnswerMention(answer, citable)
    if (named !== null && named.slug !== record.slug) return null
    return { pub: record, subPath: parsed.subPath }
  }
  if (parsed.segment !== undefined) {
    // Nothing constrains a slug to exclude `.` (`upsert_publication` takes a
    // bare string), so `publications.a.b` is ambiguous on its face. Prefer the
    // longest slug that actually exists: with both `a` and `a.b` present it
    // resolves to `a.b` with no sub-path, not to `a` with sub-path `.b`.
    const remainder = parsed.segment + parsed.subPath
    let best: Publication | null = null
    for (const pub of citable) {
      if (remainder === pub.slug || remainder.startsWith(`${pub.slug}.`)) {
        if (best === null || pub.slug.length > best.slug.length) best = pub
      }
    }
    return best === null ? null : { pub: best, subPath: remainder.slice(best.slug.length) }
  }
  const bare = resolveByAnswerMention(answer, citable) ?? (citable.length === 1 ? citable[0] : null)
  return bare === null ? null : { pub: bare, subPath: parsed.subPath }
}

/** Canonical citation path — no URL. Used everywhere a machine reads the value. */
function canonicalPath(pub: Publication, subPath: string): string {
  return `publications.${pub.slug}${subPath}`
}

/**
 * Canonical citation for the prose `Sources:` block, which a human reads and
 * where the URL is the whole point of #177 — a reader who asked "where can I
 * read it" needs the link in front of them.
 *
 * The link is emitted once per publication, on the first line citing it, and
 * suppressed on that publication's later lines. Two failure modes are being
 * avoided at once: repeating the same URL on every line of a multi-line
 * citation, and — observed live — dropping it entirely because the model
 * happened to cite only field sub-paths (`publications[0].title`,
 * `publications[0].date`) and never the record as a whole.
 */
function proseSourceLine(pub: Publication, subPath: string, linkAlreadyShown: boolean): string {
  const path = canonicalPath(pub, subPath)
  if (linkAlreadyShown) return path
  return typeof pub.canonical_url === 'string' && pub.canonical_url.length > 0
    ? `${path} — ${pub.canonical_url}`
    : path
}

/**
 * Rewrite publication source paths inside the prose `Sources:` block of a
 * cited-style answer.
 *
 * Scoped three ways so the answer body is never touched: nothing above the
 * `Sources:` line is considered, only `[N] <path>` lines match, and the
 * captured trailing whitespace is re-emitted verbatim. Non-publication source
 * lines are left byte-identical. Conversational answers carry no Sources
 * block, so this is a no-op for them.
 */
export function normalizePublicationSourceLines(answer: string, publications: unknown): string {
  if (typeof answer !== 'string') return answer
  const raw = rawPublications(publications)
  if (raw.length === 0) return answer
  const blockStart = answer.search(SOURCES_BLOCK_RE)
  if (blockStart < 0) return answer

  const head = answer.slice(0, blockStart)
  const block = answer.slice(blockStart)
  const linked = new Set<string>()
  const rewritten = block.replace(
    SOURCES_LINE_RE,
    (line, marker: string, path: string, _url: string, trailing: string) => {
      const parsed = parsePublicationSourcePath(path)
      if (parsed === null) return line
      const resolved = resolveParsedPath(parsed, answer, raw)
      if (resolved === null) return line
      const rewrittenLine = `${marker}${proseSourceLine(resolved.pub, resolved.subPath, linked.has(resolved.pub.slug))}${trailing}`
      linked.add(resolved.pub.slug)
      return rewrittenLine
    },
  )
  return head + rewritten
}

/**
 * Normalize publication paths in the JSON `sources` array — the only
 * attribution surface conversational style has, and a machine-readable mirror
 * of the prose block in cited style.
 *
 * Entries here stay bare paths with no URL appended: `sources` is a list of
 * corpus paths, and the link belongs in the structured `publications` envelope
 * field, which carries it as data rather than glued onto a string a consumer
 * has to parse apart again. (The first draft appended it here too, which broke
 * the envelope — the suffixed path stopped matching the path grammar, so
 * nothing downstream could resolve it.)
 *
 * Everything that is not a publication path is passed through untouched and in
 * order. This function normalizes citations; it does not reorder, dedupe, or
 * otherwise reinterpret entries it did not rewrite — those are the model's,
 * and tidying them here would be an unscoped change to a public API field.
 *
 * The one thing it does enforce is the field's own declared type. `sources` is
 * `string[]` in `QueryResponse` and an array of strings in the OpenAPI schema,
 * but it arrives from `parseJSON` with no runtime validation, so a model that
 * emits `null` or a number puts a value there that the contract says cannot
 * exist — and `eval-query-answer.ts` calls `.toLowerCase()` on every entry.
 * Non-strings are dropped and a non-array becomes `[]`. That is honoring the
 * declared contract, not inventing semantics for it.
 */
export function normalizePublicationSourcePaths(
  sources: string[],
  answer: string,
  publications: unknown,
): string[] {
  if (!Array.isArray(sources)) return []
  const strings = sources.filter((entry): entry is string => typeof entry === 'string')
  const raw = rawPublications(publications)
  if (raw.length === 0) return strings

  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of strings) {
    const parsed = parsePublicationSourcePath(entry)
    const resolved = parsed === null ? null : resolveParsedPath(parsed, answer, raw)
    if (resolved === null) {
      // Not a publication path, or one this function declined to resolve.
      // Either way it is returned exactly as the model wrote it — including
      // any duplicates, which are the model's business and not ours to tidy.
      out.push(entry)
      continue
    }
    // Dedupe only among entries this function rewrote: two index forms
    // collapsing onto one slug is its own doing and must not leave a
    // duplicate behind.
    const path = canonicalPath(resolved.pub, resolved.subPath)
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/**
 * The publications this answer actually cites, as structured records for the
 * response envelope — the parallel of `project_slugs`, and what a frontend
 * renders "read the piece" links from.
 *
 * Only real citation sites count: entries in the `sources` array, and
 * `[N] <path>` lines inside the prose `Sources:` block. The answer body is not
 * scanned, because the bare word "publications" in an ordinary sentence is not
 * a citation — and with a single-publication profile the fallback would
 * resolve it, attaching a "read the piece" link to an answer that cited
 * nothing.
 *
 * Every field is read from the profile record, never from the model's prose:
 * the same reason injectProjectUrls exists on the résumé path — a URL the
 * model retyped is a URL that can be wrong.
 */
export function citedPublications(
  answer: string,
  sources: unknown,
  publications: unknown,
): PublicationCitation[] {
  const raw = rawPublications(publications)
  if (raw.length === 0) return []
  const answerText = typeof answer === 'string' ? answer : ''

  const paths: string[] = Array.isArray(sources)
    ? sources.filter((s): s is string => typeof s === 'string')
    : []

  const blockStart = answerText.search(SOURCES_BLOCK_RE)
  if (blockStart >= 0) {
    for (const match of answerText.slice(blockStart).matchAll(SOURCES_LINE_RE)) paths.push(match[2])
  }

  const cited = new Map<string, Publication>()
  for (const path of paths) {
    const parsed = parsePublicationSourcePath(path)
    if (parsed === null) continue
    const resolved = resolveParsedPath(parsed, answerText, raw)
    if (resolved !== null && !cited.has(resolved.pub.slug)) cited.set(resolved.pub.slug, resolved.pub)
  }

  // `isCitable` validates only `slug` — the identity key. The rest of the
  // record is owner-supplied JSONB and can be any shape, so coerce rather than
  // forward a number or an object into a field that this type and the OpenAPI
  // schema both declare as a string.
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  return [...cited.values()].map((pub) => ({
    slug: pub.slug,
    title: str(pub.title),
    platform: str(pub.platform),
    canonical_url: str(pub.canonical_url),
    date: str(pub.date),
  }))
}

/**
 * Prefixes that could still grow into a `SOURCES_BLOCK_RE` match.
 *
 * The streaming normalizer below has to decide, for the incomplete last line
 * it is holding, whether releasing it now could split a `Sources:` marker
 * across two chunks. Line-buffering would answer that trivially, but at the
 * cost of the thing streaming exists for: an LLM emits paragraph-length prose
 * with no newline in it, so "emit only complete lines" means the reader
 * watches a blank pane and then a whole paragraph at once.
 *
 * So instead: release everything unless the trailing partial line still looks
 * like the beginning of a marker. Note the bold-delimiter prefix (`*`, `_`)
 * only matches ALONE — `*S` can never become `**Sources:` or `Sources:`, so
 * there is nothing to wait for and it is released immediately.
 *
 * The invariant this and SOURCES_BLOCK_RE jointly maintain is narrower than
 * "every prefix of a marker matches this regex" — `Sources:**` is such a prefix
 * and deliberately does not match. What actually holds: every prefix that does
 * NOT already contain a complete `Sources:` matches here, and every prefix that
 * does is caught by the full-marker `search()` that `push()` runs first. The
 * ordering of those two checks is load-bearing, not incidental. `AC-10` pins
 * the marker forms.
 */
const PARTIAL_SOURCES_RE = /^[ \t]*(?:\*|_|(?:\*\*|__)?(?:S|So|Sou|Sour|Sourc|Source|Sources|Sources:)?)$/

/**
 * The line terminators ECMAScript's `^` recognizes under the `m` flag:
 * `\n`, `\r`, `\u2028` (LINE SEPARATOR) and `\u2029` (PARAGRAPH SEPARATOR).
 *
 * Any code that computes a line-start offset to hand to SOURCES_BLOCK_RE has to
 * agree with the regex about what ends a line. Computing with
 * `lastIndexOf('\n')` alone silently disagrees, and the disagreement is not
 * benign: it lets `emitted` advance past a position the regex will later call a
 * block start, so `emitted` moves BACKWARDS and `flush()` re-emits text the
 * client already received.
 *
 * CRLF is accidentally safe — the `\n`-derived offset lands on a real line
 * start — which is exactly why a CRLF test passes while a lone `\r` duplicates
 * a character. Found by review, not by the suite; `AC-14` now pins it.
 */
const LINE_TERMINATORS = new Set(['\n', '\r', '\u2028', '\u2029'])

/** Index just past the last line terminator strictly before `before`, or 0 if there is none. */
function lastLineStart(text: string, before: number): number {
  for (let i = before - 1; i >= 0; i -= 1) {
    if (LINE_TERMINATORS.has(text[i])) return i + 1
  }
  return 0
}

/** What `createStreamingSourcesNormalizer` hands back. */
export interface StreamingSourcesNormalizer {
  /** Text safe to release now — `''` while the footer is being held. */
  push(chunk: string): string
  /** The normalized held-back footer, released once at end of stream. */
  flush(): string
}

/**
 * Streaming counterpart of `normalizePublicationSourceLines`, for the
 * `stream: true` path that has no `parseJSON` step to hook (#251).
 *
 * The contract, and the property the tests assert against every possible chunk
 * boundary: for any chunking of any input, concatenating every `push()` result
 * plus `flush()` equals `normalizePublicationSourceLines(input, publications)`.
 * The streamed bytes and the non-streamed answer are then the same citation
 * contract, which is the entire point of the issue.
 *
 * This is possible without buffering the whole response because the `Sources:`
 * block is a *trailing footer* and `normalizePublicationSourceLines` returns
 * everything above it byte-identical (`head + rewritten`). So the body streams
 * through untouched and only the footer is held — and the footer is the last
 * thing generated, so in practice the delay is a single flush at end of
 * stream, not a loss of progressive rendering.
 *
 * The full accumulated text — not just the held tail — is what gets normalized
 * at flush: `resolveParsedPath` reads the answer body to resolve a bare
 * `publications` entry by title or URL mention, and a tail-only view would
 * silently lose those resolutions.
 *
 * A profile with no publications gets an identity pass-through: nothing is
 * ever held, so a change that cannot affect the output also cannot affect
 * latency.
 */
export function createStreamingSourcesNormalizer(publications: unknown): StreamingSourcesNormalizer {
  if (rawPublications(publications).length === 0) {
    return { push: (chunk) => chunk, flush: () => '' }
  }

  let full = ''
  /** Characters of `full` already released. Invariant: once holding, this is exactly the block start. */
  let emitted = 0
  let holding = false

  return {
    push(chunk: string): string {
      full += chunk
      if (holding) return ''

      // Rescan only the line `emitted` sits in, not all of `full` — the
      // accumulated text grows with every chunk, and scanning it whole each
      // time is quadratic in the answer length.
      //
      // The offset MUST be a real line start. Slicing at `emitted` itself
      // would be faster still and is wrong: SOURCES_BLOCK_RE is `^`-anchored
      // under `m`, and `^` matches the start of the sliced string, so a
      // mid-line release would let prose like "…he wrote about " + "Sources:
      // are cited inline" match a footer that is not at a line start. Anchoring
      // to the enclosing line start keeps `^` meaning what it means in `full`.
      // `lastLineStart` — not `lastIndexOf('\n')` — because `^` under `m` also
      // treats \r, U+2028 and U+2029 as line starts; see LINE_TERMINATORS.
      const scanFrom = lastLineStart(full, emitted)
      const relativeStart = full.slice(scanFrom).search(SOURCES_BLOCK_RE)
      const blockStart = relativeStart < 0 ? -1 : scanFrom + relativeStart
      if (blockStart >= 0) {
        holding = true
        // `emitted` must never move backwards — that would make flush() re-emit
        // text the client already received. With `lastLineStart` agreeing with
        // the regex about line starts this cannot trigger; it is kept as an
        // enforced invariant rather than an assumed one, because the failure it
        // guards against is silent duplication in a live response body.
        const start = Math.max(blockStart, emitted)
        const out = full.slice(emitted, start)
        emitted = start
        return out
      }

      // Retain the trailing partial line only when it could still become a
      // marker. `lastLineStart(full, full.length)` is 0 when no terminator has
      // arrived yet, which is correct: SOURCES_BLOCK_RE is `^`-anchored under
      // `m`, and start-of-string is a line start too.
      const lineStart = lastLineStart(full, full.length)
      const safeEnd =
        lineStart >= emitted && PARTIAL_SOURCES_RE.test(full.slice(lineStart)) ? lineStart : full.length
      const out = full.slice(emitted, safeEnd)
      emitted = safeEnd
      return out
    },

    flush(): string {
      // Never saw a footer: release whatever the retention tail held back.
      if (!holding) return full.slice(emitted)
      return normalizePublicationSourceLines(full, publications).slice(emitted)
    },
  }
}

/**
 * `createStreamingSourcesNormalizer` as a `TransformStream`, which is the shape
 * both stream call sites want: `queryProfileStream` pipes the AI SDK's
 * `textStream` through it, so HTTP `/query?stream=true` and the public MCP
 * `ask_candidate` tool are both normalized from one place rather than each
 * remembering to do it.
 */
export function normalizePublicationSourcesStream(publications: unknown): TransformStream<string, string> {
  const normalizer = createStreamingSourcesNormalizer(publications)
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const out = normalizer.push(chunk)
      if (out.length > 0) controller.enqueue(out)
    },
    flush(controller) {
      const out = normalizer.flush()
      if (out.length > 0) controller.enqueue(out)
    },
  })
}
