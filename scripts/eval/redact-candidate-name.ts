/**
 * Candidate-name redaction for eval output that can end up public — the
 * weekly eval gate pastes `eval:query` stdout+stderr into an `eval-parity`
 * GitHub issue on this public repo, and the judge sweep files arbitration
 * issues.
 *
 * Pure and env-free (apart from installOutputRedaction, which patches the
 * process streams it is handed) so it's importable from tests without setup.
 */

import { escapeRegExp } from '../../src/lib/eval-query-answer.js'

/**
 * Whole-word, case-insensitive matcher for `name`. Word-boundary-safe via
 * Unicode property classes (not `\b`, which is ASCII-only and would misfire
 * around non-ASCII names) so a match can't clip into or out of an adjacent
 * word. `suffix` is an optional extra pattern appended inside the match
 * (e.g. a possessive), captured as group 1.
 */
export function wholeWordNameRe(name: string, suffix = ''): RegExp {
  return new RegExp(String.raw`(?<![\p{L}\p{N}_])${escapeRegExp(name)}(${suffix})(?![\p{L}\p{N}_])`, 'giu')
}

/**
 * Single-word forms shorter than this are skipped: an initial ("A", "Q.")
 * or two-letter token would, case-insensitively, redact ordinary words and
 * the runner's own "A:" prefix. Full/multi-word forms are always kept.
 */
export const MIN_SINGLE_WORD_FORM_LENGTH = 3

/**
 * Every name form worth redacting, longest first: the full name, first+last
 * (answers usually drop a middle name), then each word — also split on
 * hyphens, so "Mary-Kate" yields "Mary" and "Kate".
 */
export function candidateNameForms(...names: string[]): string[] {
  const forms = new Set<string>()
  for (const name of names) {
    const full = name.trim().replace(/\s+/g, ' ')
    if (!full) continue
    forms.add(full)
    const words = full.split(' ')
    if (words.length > 2) forms.add(`${words[0]} ${words[words.length - 1]}`)
    for (const word of words) {
      for (const part of new Set([word, ...word.split('-')])) {
        const bare = part.replace(/\.$/, '')
        if (bare.length >= MIN_SINGLE_WORD_FORM_LENGTH) forms.add(bare)
      }
    }
  }
  return [...forms].sort((a, b) => b.length - a.length)
}

/** Text so far ends at a sentence/line start, allowing opening quotes, brackets, or markdown emphasis. */
const SENTENCE_START_RE = /(^|[.!?:]\s+|\n\s*)["'“‘(*[]*$/u

/**
 * Replace the candidate's name with the role phrase "the candidate" —
 * "Jamie Doe built X" → "The candidate built X", "Jamie's" → "the
 * candidate's". Capitalized at the start of the text or of a sentence/line.
 * Full-name forms run before single words (see candidateNameForms) so
 * "Jamie Doe" collapses to one "the candidate", not two.
 */
export function redactCandidateNameToRole(text: string, forms: readonly string[]): string {
  let out = text
  for (const form of forms) {
    if (!form) continue
    out = out.replace(wholeWordNameRe(form, `['’]s|`), (_match, possessive: string, offset: number, whole: string) => {
      const sentenceStart = SENTENCE_START_RE.test(whole.slice(0, offset))
      const phrase = sentenceStart ? 'The candidate' : 'the candidate'
      return phrase + (possessive ? "'s" : '')
    })
  }
  return out
}

type Write = NodeJS.WriteStream['write']

/**
 * Route every write to `streams` through redactCandidateNameToRole — so
 * console.* output from src/ modules (e.g. a logged raw model reply) is
 * covered too, not only the runner's own writes.
 */
export function installOutputRedaction(forms: readonly string[], streams: NodeJS.WriteStream[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : chunk
      return original(typeof text === 'string' ? redactCandidateNameToRole(text, forms) : text, ...rest)
    }) as Write
  }
}
