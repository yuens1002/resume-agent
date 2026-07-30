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

/**
 * Stamped on an updated thought whose existing metadata carries no usable
 * `source`. Deliberately NOT `'mcp'`.
 *
 * `'mcp'` was the original fallback, when `source` was provenance and nothing
 * read it. #222 changed that: `AUTHORED_THOUGHT_SOURCES` (src/lib/observations.ts)
 * treats `'mcp'` as the marker of a hand-authored note, so the old fallback meant
 * *any* edit to a source-less row silently promoted machine output to authored.
 * That is not hypothetical — 122 rows whose content is literally
 * `RESUME_RUBRIC_FAILURE: …` and `Applied to …` now carry `source: 'mcp'`,
 * acquired by being edited through `update_thought` during a privacy sweep.
 *
 * `'unknown'` is outside the allowlist, so an unlabelled row stays classified as
 * not-authored — the fail-closed direction for a crawlable surface, and the same
 * choice the allowlist itself makes.
 */
export const UNKNOWN_THOUGHT_SOURCE = 'unknown'

/**
 * Decide the `source` and `private` flags to stamp on a thought being updated.
 *
 * `source` is preserved from the existing row, falling back to
 * {@link UNKNOWN_THOUGHT_SOURCE} if missing or malformed. `private` is preserved
 * from the existing row UNLESS the caller passes an explicit boolean override —
 * `undefined` means "leave unchanged", not "make public". This mirrors the
 * capture-side invariant in buildThoughtMetadata: the privacy flag is always
 * caller-controlled, never inferred from extracted text.
 */
export function resolveThoughtUpdateOpts(
  existingMeta: unknown,
  override: { private?: boolean },
): { source: string; private: boolean } {
  const meta =
    existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
      ? (existingMeta as Record<string, unknown>)
      : {}
  const source = typeof meta.source === 'string' && meta.source.length > 0 ? meta.source : UNKNOWN_THOUGHT_SOURCE
  const existingPrivate = meta.private === true
  const nextPrivate = override.private !== undefined ? override.private : existingPrivate
  return { source, private: nextPrivate }
}
