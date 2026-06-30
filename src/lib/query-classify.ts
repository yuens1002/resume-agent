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

// binary: 300 | behavioral: 1024 | everything else: 600 cited / 512 conversational
// Behavioral answers need the full 1024 ceiling regardless of style — conversational
// JSON envelopes are nearly as large as cited ones (sources[], follow_up_suggestions[]
// still present). Flat-capping conversational at 512 truncates mid-JSON for broad
// behavioral questions ("Tell me about…") and causes silent parse failures.
export function maxTokensForQuestion(question: string, style: 'cited' | 'conversational'): number {
  if (isBinaryQuestion(question)) return 300
  if (isBehavioralQuestion(question)) return 1024
  return style === 'conversational' ? 512 : 600
}
