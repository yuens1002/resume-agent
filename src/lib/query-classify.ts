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
  // Behavioral signals indicate the model needs observations context
  return !/\b(how|why|walk|describe|explain|tell me|experience|approach|decision|tradeoff)\b/.test(q)
}

export function isBehavioralQuestion(question: string): boolean {
  const q = question.toLowerCase().trim()
  return /\b(how do you|walk me through|tell me about|describe (a |your )|what[''']?s your approach|approach to|what is your approach|how (would|did|do) you handle|how (have|did) you)\b/.test(q)
}

// binary: 300 | behavioral: 1024 | everything else: 1024 cited / 800 conversational
// Cited responses include inline citation markers ([1], [2], …) for every project mentioned.
// A 7-project exhaustive listing in cited style adds ~100+ tokens of citation overhead on top
// of the prose, causing parse failures at 800. Raising cited to 1024 matches behavioral and
// gives sufficient headroom. Conversational stays at 800 — no citation markup, shorter output.
export function maxTokensForQuestion(question: string, style: 'cited' | 'conversational'): number {
  if (isBinaryQuestion(question)) return 300
  if (isBehavioralQuestion(question)) return 1024
  return style === 'cited' ? 1024 : 800
}
