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
const SOURCES_BLOCK_RE = /^[ \t]*Sources:[ \t]*$/m

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
 * Find the single publication an answer is talking about, by looking for its
 * title or canonical_url in the prose. Returns null when zero or more than one
 * match — "more than one" is genuinely ambiguous and must not be resolved.
 */
function resolveByAnswerMention(answer: string, citable: Publication[]): Publication | null {
  const haystack = answer.toLowerCase()
  const mentioned = citable.filter((pub) => {
    const title = typeof pub.title === 'string' && pub.title.length > 0 ? pub.title.toLowerCase() : null
    const url = typeof pub.canonical_url === 'string' && pub.canonical_url.length > 0 ? pub.canonical_url.toLowerCase() : null
    return (title !== null && haystack.includes(title)) || (url !== null && haystack.includes(url))
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
function resolveParsedPath(
  parsed: ParsedSourcePath,
  answer: string,
  raw: unknown[],
): Publication | null {
  if (parsed.index !== undefined) {
    // Indexed against the raw array — see rule 1 in the module header. The
    // resolved record is then validated, so an index pointing at a malformed
    // row yields nothing rather than silently sliding onto its neighbour.
    if (!Number.isInteger(parsed.index) || parsed.index < 0 || parsed.index >= raw.length) return null
    const record = raw[parsed.index]
    return isCitable(record) ? record : null
  }
  const citable = raw.filter(isCitable)
  if (parsed.segment !== undefined) {
    return citable.find((pub) => pub.slug === parsed.segment) ?? null
  }
  return resolveByAnswerMention(answer, citable) ?? (citable.length === 1 ? citable[0] : null)
}

/** Canonical citation path — no URL. Used everywhere a machine reads the value. */
function canonicalPath(pub: Publication, subPath: string): string {
  return `publications.${pub.slug}${subPath}`
}

/**
 * Canonical citation for the prose `Sources:` block, which a human reads and
 * where the URL is the whole point of #177 — a reader who asked "where can I
 * read it" needs the link in front of them. A sub-path citation
 * (`.grounded_in`) names a field of the record rather than the piece itself,
 * so it takes no URL; otherwise every line would repeat the same link.
 */
function proseSourceLine(pub: Publication, subPath: string): string {
  const path = canonicalPath(pub, subPath)
  if (subPath.length > 0) return path
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
  const rewritten = block.replace(
    SOURCES_LINE_RE,
    (line, marker: string, path: string, _url: string, trailing: string) => {
      const parsed = parsePublicationSourcePath(path)
      if (parsed === null) return line
      const resolved = resolveParsedPath(parsed, answer, raw)
      return resolved === null ? line : `${marker}${proseSourceLine(resolved, parsed.subPath)}${trailing}`
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
 * Everything that is not a publication path is passed through untouched, in
 * order, including entries the model returned as non-strings — this function
 * normalizes citations, it is not a place to quietly start validating an
 * unrelated public API field.
 */
export function normalizePublicationSourcePaths(
  sources: string[],
  answer: string,
  publications: unknown,
): string[] {
  if (!Array.isArray(sources)) return sources
  const raw = rawPublications(publications)
  if (raw.length === 0) return sources

  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of sources) {
    const parsed = typeof entry === 'string' ? parsePublicationSourcePath(entry) : null
    if (parsed === null) {
      out.push(entry)
      continue
    }
    const resolved = resolveParsedPath(parsed, answer, raw)
    const path = resolved === null ? entry : canonicalPath(resolved, parsed.subPath)
    // Dedupe only among publication entries — two index forms collapsing onto
    // one slug is this function's own doing and must not leave a duplicate.
    // Duplicates elsewhere in the array are the model's business, not ours.
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
    if (resolved !== null && !cited.has(resolved.slug)) cited.set(resolved.slug, resolved)
  }

  return [...cited.values()].map((pub) => ({
    slug: pub.slug,
    title: pub.title ?? '',
    platform: pub.platform ?? '',
    canonical_url: pub.canonical_url ?? '',
    date: pub.date ?? '',
  }))
}
