/**
 * Build the metadata blob persisted with a captured thought.
 *
 * The model-extracted metadata (type, topics, people, action_items, …) is
 * treated as untrusted, content-derived data: any `source` or `private` keys it
 * emits are stripped, and those flags are then set *only* from the explicit
 * caller arguments. This keeps the `capture_thought` contract honest — `private`
 * is controlled by the caller, never by model drift or a prompt-injection string
 * smuggled inside the thought text.
 */

const RESERVED_METADATA_KEYS: readonly string[] = ['source', 'private']

export function buildThoughtMetadata(
  extracted: unknown,
  opts: { source: string; private?: boolean },
): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  if (extracted && typeof extracted === 'object' && !Array.isArray(extracted)) {
    for (const [key, value] of Object.entries(extracted as Record<string, unknown>)) {
      if (RESERVED_METADATA_KEYS.includes(key)) continue
      base[key] = value
    }
  }
  base.source = opts.source
  if (opts.private) base.private = true
  return base
}
