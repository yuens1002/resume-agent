// Factual-decline phrasings the agent might use for an off-topic or
// in-scope-but-no-data question. Known-value substrings, not example
// phrasings from the spec — these describe the *shape* of an honest decline.
// Shared between the eval rubric (src/lib/eval-query-answer.ts) and the
// live query route (src/routes/query.ts), which needs the same detection to
// deterministically zero out follow_up_suggestions on a decline (#215): the
// v2 contract is "the decline is the answer; no contact channels, no
// follow-up offers," but that's prompt-only guidance today and the model
// doesn't reliably comply for the no-data case, whose sibling gap examples
// (binary, capability) are worked with non-empty follow_up_suggestions.
export const FACTUAL_DECLINE_PHRASES: readonly string[] = [
  'outside the scope',
  'not in the candidate',
  'does not appear to have',
  "doesn't appear to have",
  'no documented',
  'not documented',
  'not in the work history',
  'no relevant work history',
]

export function isDeclineShapedAnswer(answer: string): boolean {
  const lower = answer.toLowerCase()
  return FACTUAL_DECLINE_PHRASES.some((p) => lower.includes(p.toLowerCase()))
}
