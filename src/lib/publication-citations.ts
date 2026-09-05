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
// Guiding rule throughout: never guess. An entry that cannot be resolved to
// exactly one publication is returned exactly as the model wrote it — a
// confidently wrong citation is worse than an unnormalized one, in a system
// whose entire value proposition is verifiable evidence.
import type { Publication } from '../types.js'

/** Machine-readable citation surfaced on the /query envelope. */
export interface PublicationCitation {
  slug: string
  title: string
  platform: string
  canonical_url: string
  date: string
}

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
 * Find the single publication an answer is talking about, by looking for its
 * title or canonical_url in the prose. Returns null when zero or more than one
 * match — "more than one" is genuinely ambiguous and must not be resolved.
 */
function resolveByAnswerMention(answer: string, publications: Publication[]): Publication | null {
  const haystack = answer.toLowerCase()
  const mentioned = publications.filter((pub) => {
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
  publications: Publication[],
): Publication | null {
  if (parsed.index !== undefined) {
    return Number.isInteger(parsed.index) && parsed.index >= 0 && parsed.index < publications.length
      ? publications[parsed.index]
      : null
  }
  if (parsed.segment !== undefined) {
    return publications.find((pub) => pub.slug === parsed.segment) ?? null
  }
  return resolveByAnswerMention(answer, publications) ?? (publications.length === 1 ? publications[0] : null)
}

/**
 * Canonical citation path for a resolved record. Whole-record citations carry
 * the canonical URL — that is the citable evidence a reader follows, and the
 * gap #177 exists to close. Sub-path citations (`.grounded_in`) name a field
 * of the record, not the piece itself, so appending the URL there would just
 * repeat it on every line.
 */
function canonicalSourceLine(pub: Publication, subPath: string): string {
  const path = `publications.${pub.slug}${subPath}`
  if (subPath.length > 0) return path
  return typeof pub.canonical_url === 'string' && pub.canonical_url.length > 0
    ? `${path} — ${pub.canonical_url}`
    : path
}

/** Drop unusable records up front so every downstream index lines up with what the model saw. */
function citableOnly(publications: unknown): Publication[] {
  return Array.isArray(publications) ? publications.filter(isCitable) : []
}

/**
 * Rewrite one source path to its canonical form, or return it unchanged when
 * it is not a publication path or cannot be resolved to exactly one record.
 */
function normalizeOneSourcePath(path: string, answer: string, publications: Publication[]): string {
  const parsed = parsePublicationSourcePath(path)
  if (parsed === null) return path
  const resolved = resolveParsedPath(parsed, answer, publications)
  return resolved === null ? path : canonicalSourceLine(resolved, parsed.subPath)
}

/**
 * Normalize publication paths inside the prose `Sources:` block of a cited-style
 * answer. Only lines shaped `[N] <path>` are touched, and only when `<path>`
 * addresses publications — every other source line, and every character of the
 * answer above the Sources block, is left byte-identical.
 *
 * Conversational answers carry no Sources block, so this is a no-op for them.
 */
export function normalizePublicationSourceLines(answer: string, publications: unknown): string {
  const citable = citableOnly(publications)
  if (citable.length === 0 || typeof answer !== 'string') return answer
  return answer.replace(
    /^(\s*\[\d+\]\s*)(publications(?:\[-?\d+\]|\.[A-Za-z0-9_-]+)?(?:\.[A-Za-z0-9_-]+)*)\s*$/gm,
    (line, marker: string, path: string) => {
      const normalized = normalizeOneSourcePath(path, answer, citable)
      return normalized === path ? line : `${marker}${normalized}`
    },
  )
}

/**
 * Normalize publication paths in the JSON `sources` array — the only
 * attribution surface conversational style has, and a machine-readable mirror
 * of the prose block in cited style.
 *
 * Non-publication paths keep their original order and spelling. Duplicates
 * introduced by normalization (two index forms collapsing onto one slug) are
 * removed, since the array is a set of citations, not a per-marker list.
 */
export function normalizePublicationSourcePaths(
  sources: unknown,
  answer: string,
  publications: unknown,
): string[] {
  if (!Array.isArray(sources)) return []
  const citable = citableOnly(publications)
  const normalized = sources.map((path) =>
    typeof path === 'string' && citable.length > 0 ? normalizeOneSourcePath(path, answer, citable) : path,
  )
  return [...new Set(normalized.filter((path): path is string => typeof path === 'string'))]
}

/**
 * The publications this answer actually cites, as structured records for the
 * response envelope — the parallel of `project_slugs`, and what a frontend
 * renders "read the piece" links from.
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
  const citable = citableOnly(publications)
  if (citable.length === 0) return []
  const cited = new Map<string, Publication>()

  const record = (pub: Publication | null): void => {
    if (pub !== null && !cited.has(pub.slug)) cited.set(pub.slug, pub)
  }

  const paths = [
    ...(Array.isArray(sources) ? sources.filter((s): s is string => typeof s === 'string') : []),
    ...(typeof answer === 'string'
      ? [...answer.matchAll(/\bpublications(?:\[-?\d+\]|\.[A-Za-z0-9_-]+)?(?:\.[A-Za-z0-9_-]+)*/g)].map((m) => m[0])
      : []),
  ]

  for (const path of paths) {
    const parsed = parsePublicationSourcePath(path)
    if (parsed !== null) record(resolveParsedPath(parsed, answer, citable))
  }

  return [...cited.values()].map((pub) => ({
    slug: pub.slug,
    title: pub.title ?? '',
    platform: pub.platform ?? '',
    canonical_url: pub.canonical_url ?? '',
    date: pub.date ?? '',
  }))
}
