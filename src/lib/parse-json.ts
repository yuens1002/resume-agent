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

  // Extract first {...} block
  const match = raw.match(/\{[\s\S]*\}/)
  if (match) {
    return JSON.parse(match[0]) as T
  }

  throw new Error('No valid JSON found in response')
}
