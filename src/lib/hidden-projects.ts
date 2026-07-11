/**
 * `HIDE_FROM_PROJECTS` — a comma-separated list of project slugs (env var)
 * excluded from candidate-facing generated output. Originally applied only
 * to `/resume` (src/routes/resume.ts); shared here so `/query`'s prompt-build
 * path (src/routes/query.ts) can apply the identical exclusion (#176).
 *
 * One mechanism, two consumers — do not duplicate this parsing or filtering
 * logic in either route.
 */

/** Parse the raw `HIDE_FROM_PROJECTS` env value into a slug Set. Trims each
 * entry and drops empties, so trailing commas / stray whitespace can't
 * produce a spurious `''` slug in the set. */
export function parseHiddenProjectSlugs(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  )
}

/** Drop hidden-by-slug projects from a `projects` array. Non-array or
 * empty-hidden-set input is returned unchanged (identity, not a copy) so an
 * unset `HIDE_FROM_PROJECTS` is a true no-op for callers that compare by
 * reference or byte-identity. */
export function filterVisibleProjects(projects: unknown, hidden: Set<string>): unknown {
  if (!Array.isArray(projects) || hidden.size === 0) return projects
  return (projects as unknown[]).filter(
    (p): p is import('../types.js').Project =>
      p !== null && typeof p === 'object' &&
      typeof (p as { slug?: unknown }).slug === 'string' &&
      !hidden.has((p as { slug: string }).slug),
  )
}
