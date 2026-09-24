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
  return nameAlternationRe([name], 'giu', suffix)
}

/** wholeWordNameRe over several names at once (an alternation, tried in the given order). */
function nameAlternationRe(names: readonly string[], flags: string, suffix = ''): RegExp {
  const alternation = names.map(escapeRegExp).join('|')
  return new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${alternation})(${suffix})(?![\p{L}\p{N}_])`, flags)
}

/**
 * Single-word forms shorter than this match case-sensitively (exactly as
 * written in the profile) instead of case-insensitively, so a two-letter
 * name like "Li" is still redacted without eating lowercase ordinary words.
 * A two-letter name that is also a common word ("He", "An") will still eat
 * that word where it is capitalized, e.g. sentence-initially — accepted:
 * over-redaction is the safe direction. One-letter tokens and initials
 * ("A", "Q.") are dropped entirely: even case-sensitive, "A" would eat the
 * runner's own "A:" prefix and every sentence-initial article.
 */
export const MIN_CASE_INSENSITIVE_FORM_LENGTH = 3

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
        if (bare.length > 1) forms.add(bare)
      }
    }
  }
  return [...forms].sort((a, b) => b.length - a.length)
}

const POSSESSIVE = `['’]s|`

/**
 * The forms redactCandidateNameToRole actually uses: deduped, one-letter
 * tokens dropped, longest first. Empty means nothing would be redacted —
 * callers that must not leak (run-eval.ts) refuse to run on that.
 */
export function redactableForms(forms: readonly string[]): string[] {
  return [...new Set(forms.filter((f) => f.length > 1))].sort((a, b) => b.length - a.length)
}

/** Text so far ends at a sentence/line start, allowing opening quotes, brackets, or markdown emphasis. */
const SENTENCE_START_RE = /(^|[.!?:]\s+|\n\s*)["'“‘(*[]*$/u

/**
 * Replace the candidate's name with the role phrase "the candidate" —
 * "Jamie Doe built X" → "The candidate built X", "Jamie's" → "the
 * candidate's". Capitalized at the start of the text or of a sentence/line.
 *
 * All forms go into one alternation, longest first, and the text is scanned
 * once per case tier — so "Jamie Doe" collapses to one "the candidate", and
 * a form can never re-match inside an already-inserted "the candidate"
 * (a surname like "The" or "Candidate" would otherwise do exactly that).
 */
export function redactCandidateNameToRole(text: string, forms: readonly string[]): string {
  const valid = redactableForms(forms)
  const long = valid.filter((f) => f.length >= MIN_CASE_INSENSITIVE_FORM_LENGTH || f.includes(' '))
  const short = valid.filter((f) => !long.includes(f))
  let out = text
  if (long.length) out = out.replace(nameAlternationRe(long, 'giu', POSSESSIVE), toRole)
  // Case-sensitive short forms are ≤2 letters and whole-word, so they can't
  // match inside the "the candidate" the first pass inserted.
  if (short.length) out = out.replace(nameAlternationRe(short, 'gu', POSSESSIVE), toRole)
  return out
}

function toRole(_match: string, possessive: string, offset: number, whole: string): string {
  const phrase = SENTENCE_START_RE.test(whole.slice(0, offset)) ? 'The candidate' : 'the candidate'
  return phrase + (possessive ? "'s" : '')
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
