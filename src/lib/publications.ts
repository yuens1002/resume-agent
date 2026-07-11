// Pure find-by-slug upsert logic for the `publications` array on public_profile.
// Extracted from the inline pattern used by upsert_project (src/routes/mcp.ts)
// so it can be unit tested without a live Supabase connection — the MCP tool
// itself stays a thin wrapper around this function plus the fetch/update calls.
import type { Publication } from '../types.js'

// Fields required to insert a brand-new publication (slug is always required
// as the identity key and is validated separately by the caller). Mirrors
// upsert_project's REQUIRED_FOR_INSERT — narrative fields required on insert,
// optional on update so a partial merge never has to resend the whole record.
export const REQUIRED_FOR_NEW_PUBLICATION = ['title', 'platform', 'canonical_url', 'date', 'tags', 'grounded_in'] as const

export interface UpsertPublicationInput {
  slug: string
  title?: string
  platform?: string
  canonical_url?: string
  date?: string
  tags?: string[]
  grounded_in?: string
}

export type MergePublicationResult =
  | { ok: true; publications: Publication[]; action: 'added' | 'updated' }
  | { ok: false; error: string }

export function mergePublication(
  publications: Publication[],
  input: UpsertPublicationInput
): MergePublicationResult {
  const existingIdx = publications.findIndex((p) => p.slug === input.slug)
  const incoming = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))

  if (existingIdx >= 0) {
    const updated = [...publications]
    updated[existingIdx] = { ...updated[existingIdx], ...incoming } as Publication
    return { ok: true, publications: updated, action: 'updated' }
  }

  const missing = REQUIRED_FOR_NEW_PUBLICATION.filter((f) => incoming[f as keyof typeof incoming] === undefined)
  if (missing.length > 0) {
    return { ok: false, error: `Missing required field(s) for new publication: ${missing.join(', ')}` }
  }

  return { ok: true, publications: [...publications, incoming as unknown as Publication], action: 'added' }
}
