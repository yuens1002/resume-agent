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
 * Decide the `source` and `private` flags to stamp on a thought being updated.
 *
 * `source` is preserved from the existing row (falling back to "mcp" only if
 * missing or malformed). `private` is preserved from the existing row UNLESS
 * the caller passes an explicit boolean override — `undefined` means "leave
 * unchanged", not "make public". This mirrors the capture-side invariant in
 * buildThoughtMetadata: the privacy flag is always caller-controlled, never
 * inferred from extracted text.
 */
export function resolveThoughtUpdateOpts(
  existingMeta: unknown,
  override: { private?: boolean },
): { source: string; private: boolean } {
  const meta =
    existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
      ? (existingMeta as Record<string, unknown>)
      : {}
  const source = typeof meta.source === 'string' && meta.source.length > 0 ? meta.source : 'mcp'
  const existingPrivate = meta.private === true
  const nextPrivate = override.private !== undefined ? override.private : existingPrivate
  return { source, private: nextPrivate }
}
