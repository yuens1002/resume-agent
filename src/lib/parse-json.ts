// Models sometimes wrap JSON in markdown fences or add prose — extract the first JSON object
export function parseJSON<T>(raw: string): T {
  // Try direct parse first
  try {
    return JSON.parse(raw) as T
  } catch {}

  // Strip markdown code fences
  const stripped = raw.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim()
  try {
    return JSON.parse(stripped) as T
  } catch {}

  // Extract first {...} block from stripped output
  const match = stripped.match(/\{[\s\S]*\}/)
  if (match) {
    return JSON.parse(match[0]) as T
  }

  throw new Error('No valid JSON found in response')
}

/**
 * Salvage a `Sources:` trailer that the model emitted AFTER the JSON
 * envelope (and, usually, after the closing ``` fence) — parseJSON's
 * greedy `{...}` extraction discards everything past the last `}`, so a
 * shape like:
 *
 *   ```json
 *   { "answer": "... [1] ... [2] ..." , ... }
 *   ```
 *
 *   Sources:
 *   [1] skills.data_infrastructure
 *   [2] projects
 *
 * parses successfully but silently drops the Sources block, leaving an
 * answer with citation markers and no attribution (#193/#197). Only acts
 * when the parsed answer has a citation marker but no Sources line of its
 * own, and only reattaches a Sources block found strictly after the JSON's
 * closing brace in the raw text — never touches an already-complete answer
 * or a raw response with no discarded trailer.
 */
export function salvageTrailingSourcesBlock(raw: string, parsedAnswer: string): string {
  if (!/\[[1-9]\d*\]/.test(parsedAnswer)) return parsedAnswer
  if (parsedAnswer.includes('Sources:')) return parsedAnswer

  const lastBraceIndex = raw.lastIndexOf('}')
  if (lastBraceIndex === -1) return parsedAnswer

  const trailer = raw.slice(lastBraceIndex + 1)
  const sourcesMatch = trailer.match(/Sources:\s*\n(?:\[\d+\][^\n]*\n?)+/)
  if (!sourcesMatch) return parsedAnswer

  return `${parsedAnswer}\n\n${sourcesMatch[0].trim()}`
}
