/**
 * Pure question-classification helpers for /query.
 *
 * Extracted from src/routes/query.ts so unit tests can import without
 * triggering env-var checks in src/lib/ai.ts.
 *
 * Used for two optimizations:
 *   1. Skip thoughts retrieval for binary questions (embedding call costs ~150ms)
 *   2. Set per-category maxTokens — behavioral answers hit the 1024 ceiling;
 *      binary/decline answers never come close. Smaller caps cut LLM generation
 *      time while keeping enough headroom for the JSON structure to close cleanly.
 */

export function isBinaryQuestion(question: string): boolean {
  const q = question.toLowerCase().trim()
  if (q.split(/\s+/).length >= 15) return false
  if (!/^(did|does|has|have|is|was|were|will|can|could|would|should)\b/.test(q)) return false
  // Behavioral signals indicate the model needs observations context.
  // Fit/suitability signals (#199) mean the answer is a profile-vs-role
  // comparison, not a yes/no: "Is [name] a fit for…?" opens like a binary
  // question but needs retrieval context and a long answer — treating it as
  // binary skipped thoughts retrieval and set a 300-token cap that truncated
  // real fit answers mid-JSON. This keyword screen also acts as the safety
  // net for paths where the classifier's narrate_fit flag isn't available
  // (streaming, classifier fallback): such fit questions land on the default
  // 1024/800 cap instead of 300.
  return !/\b(how|why|walk|describe|explain|tell me|experience|approach|decision|tradeoff|fit|fits|suited|suits|qualified|match|matches|hire|hiring)\b/.test(q)
}

export function isBehavioralQuestion(question: string): boolean {
  const q = question.toLowerCase().trim()
  return /\b(how do you|walk me through|tell me about|describe (a |your )|what[''']?s your approach|approach to|what is your approach|how (would|did|do) you handle|how (have|did) you)\b/.test(q)
}

// binary: 300 | fit question: 1536 | behavioral: 1024 | everything else: 1024 cited / 800 conversational
// Cited responses include inline citation markers ([1], [2], …) for every project mentioned.
// A 7-project exhaustive listing in cited style adds ~100+ tokens of citation overhead on top
// of the prose, causing parse failures at 800. Raising cited to 1024 matches behavioral and
// gives sufficient headroom. Conversational stays at 800 — no citation markup, shorter output.
//
// fitQuestion (#199): fit questions narrate under the narrate-first spec (#195) instead of
// opening the tool, and a profile-vs-role comparison is the longest answer shape the system
// produces — 1024 truncated one mid-JSON on the very first smoke test (the #193 parse_error
// shape). The classifier route is known before generation, so the ceiling keys on it.
export function maxTokensForQuestion(
  question: string,
  style: 'cited' | 'conversational',
  fitQuestion = false,
): number {
  // fitQuestion wins over the binary heuristic: "Is [name] a fit for X?"
  // pattern-matches isBinaryQuestion (starts with "Is", short, no behavioral
  // keywords), but the answer is a full profile-vs-role comparison — 300
  // tokens truncates it mid-JSON and the request 500s as a parse_error.
  // The classifier's route is the stronger signal; trust it first.
  if (fitQuestion) return 1536
  if (isBinaryQuestion(question)) return 300
  if (isBehavioralQuestion(question)) return 1024
  return style === 'cited' ? 1024 : 800
}
