/**
 * Deterministic format + content-budget pass over a generated resume (#298).
 *
 * Runs after stripBannedPhrases and before scoring, so the rubric scores what
 * actually ships. It removes or rewords the model's output and never invents
 * content or a number; the only addition is pinned roles, copied verbatim
 * from the profile.
 *
 * The budget targets a one-page resume's content (r/EngineeringResumes).
 * Physical page fit depends on each consumer's layout, so it isn't claimed.
 */

import type { Employment, ResumeResponse, Skill } from '../types.js'

export const RESUME_BUDGET = Object.freeze({
  summarySentences: 2,
  mostRecentRoleBullets: 4,
  otherRoleBullets: 2,
  projects: 2,
  projectHighlights: 3,
  skillRows: 4,
})

/**
 * Project names shorter than this don't drive the self-employment dedupe: a
 * very short name ("AI", "UX") would match ordinary words and drop real bullets.
 */
const MIN_DEDUPE_NAME_LENGTH = 3

/** Employment entries treated as self-employment for the Projects dedupe. */
const SELF_EMPLOYED_RE = /\b(self[- ]?employed|freelance|independent)\b/i

/** Numeric tokens, including decimals and thousands separators ("11.3", "1,200"). */
export const NUMBER_RE = /\d+(?:[.,]\d+)*/g

/**
 * Numbers a generated bullet may cite: those in the candidate's own written
 * text (employment bullets, project prose) and in the Open Brain thoughts the
 * model was given. Dates, counts and ids elsewhere in the profile are left
 * out, so they can't make an invented figure look grounded.
 */
export function groundedNumbers(profile: unknown, thoughts: readonly string[]): Set<string> {
  const p = (profile ?? {}) as { employment?: unknown; projects?: unknown }
  const employment = Array.isArray(p.employment) ? (p.employment as Array<{ bullets?: unknown }>) : []
  const projects = Array.isArray(p.projects) ? (p.projects as Array<Record<string, unknown>>) : []
  const prose: string[] = [
    ...employment.flatMap((e) => (Array.isArray(e?.bullets) ? e.bullets : []).filter((b): b is string => typeof b === 'string')),
    ...projects.flatMap((pr) => [pr?.description, pr?.impact, pr?.problem, ...(Array.isArray(pr?.highlights) ? pr.highlights : [])]
      .filter((x): x is string => typeof x === 'string')),
    ...thoughts,
  ]
  return new Set(prose.join(' ').match(NUMBER_RE) ?? [])
}

/**
 * Enforces "never invent a metric" on the request path: drops any
 * generator-written employment bullet or project highlight that cites a
 * number not in `grounded`. Pinned roles are the owner's own text and are
 * left alone. The summary is excluded, since years of experience are
 * legitimately derived from dates. If this would leave a role with no
 * bullets, the role falls back to its first bullet from `profileEmployment`,
 * which is the owner's own text and so grounded by definition. Returns what
 * was dropped for logging.
 */
export function dropUngroundedNumbers(
  resume: ResumeResponse,
  grounded: ReadonlySet<string>,
  profileEmployment?: unknown,
): { resume: ResumeResponse; dropped: string[] } {
  const dropped: string[] = []
  const keep = (text: string) => {
    const ok = (text.match(NUMBER_RE) ?? []).every((n) => grounded.has(n))
    if (!ok) dropped.push(text)
    return ok
  }
  const profileRoles = Array.isArray(profileEmployment) ? (profileEmployment as Employment[]) : []
  const fallbackFor = (e: Employment): string[] => {
    const src = profileRoles.find((p) => companyKey(p?.company) === companyKey(e.company) && p?.start_date === e.start_date) ??
      profileRoles.find((p) => companyKey(p?.company) === companyKey(e.company))
    const first = Array.isArray(src?.bullets) ? src.bullets.find((b): b is string => typeof b === 'string') : undefined
    return first ? [cleanBullet(first)] : []
  }
  const out: ResumeResponse = {
    ...resume,
    employment: (resume.employment ?? []).map((e) => {
      if (e.pinned) return e
      const kept = (e.bullets ?? []).filter(keep)
      return { ...e, bullets: kept.length || !(e.bullets ?? []).length ? kept : fallbackFor(e) }
    }),
    projects: (resume.projects ?? []).map((p) => ({ ...p, highlights: (p.highlights ?? []).filter(keep) })),
  }
  return { resume: out, dropped }
}

/** Trailing periods off, a standalone "&" spelled out. "R&D"-style names are untouched. */
export function cleanBullet(text: string): string {
  return text
    .trim()
    .replace(/\s+&\s+/g, ' and ')
    .replace(/\.+$/, '')
    .trim()
}

/** The first `max` sentences. A period inside a token (Node.js, 3.5x) or after a common abbreviation (Inc., e.g.) is not a sentence end. */
export function capSentences(text: string, max: number): string {
  return splitSentences(text).slice(0, max).join(' ')
}

/**
 * Sentences in `text`: split after ., ! or ? followed by whitespace, whatever
 * the case of the next word, except after a common abbreviation. A period
 * inside a token (Node.js, 11.3s) has no whitespace after it, so it never splits.
 */
export function splitSentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?])(?<!\b(?:Inc|Ltd|Co|Corp|Jr|Sr|Dr|Mr|Ms|vs|etc|e\.g|i\.e)\.)\s+/).filter(Boolean)
}

function cleanList(items: unknown, cap: number): string[] {
  if (!Array.isArray(items)) return []
  return items
    .filter((i): i is string => typeof i === 'string')
    .map(cleanBullet)
    .filter(Boolean)
    .slice(0, cap)
}

function mentions(bullet: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(bullet)
}

const companyKey = (c: unknown) => String(c ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Profile employment entries the owner pinned (`pinned: true`) that carry a bullets array. */
function pinnedEntries(profileEmployment: unknown): Employment[] {
  if (!Array.isArray(profileEmployment)) return []
  return (profileEmployment as Employment[]).filter((e) => e?.pinned === true && Array.isArray(e.bullets))
}

/**
 * Whether a model-emitted entry is the model's own copy of pinned role `p`,
 * which is then dropped in favour of the profile's version. Same company and
 * start date; or same company when it's the profile's only role there; or the
 * same title and dates (a renamed company). A different role at the same
 * company, with its own start date, is never matched.
 */
function copiesPinned(e: Employment, p: Employment, rolesPerCompany: Map<string, number>): boolean {
  const sameCompany = companyKey(e.company) === companyKey(p.company)
  if (sameCompany && e.start_date === p.start_date) return true
  if (sameCompany && (rolesPerCompany.get(companyKey(p.company)) ?? 0) === 1) return true
  return (
    e.start_date === p.start_date &&
    (e.end_date ?? null) === (p.end_date ?? null) &&
    String(e.title ?? '').trim().toLowerCase() === String(p.title ?? '').trim().toLowerCase()
  )
}

/**
 * `profileEmployment` is the profile's employment array. Roles pinned there
 * (#298 D9) always come from the profile, never from the model: each is
 * inserted exactly once with the profile's company, title, dates and bullets
 * verbatim, exempt from caps and dedupe, and any model copy of it is dropped.
 * Model entries can never be marked pinned.
 */
export function normalizeResumeFormat(resume: ResumeResponse, profileEmployment?: unknown): ResumeResponse {
  const out: ResumeResponse = structuredClone(resume)
  const b = RESUME_BUDGET

  if (typeof out.summary === 'string') out.summary = capSentences(out.summary, b.summarySentences)

  out.projects = (out.projects ?? []).slice(0, b.projects).map((p) => ({
    ...p,
    highlights: cleanList(p.highlights, b.projectHighlights),
  }))
  const featuredNames = out.projects.map((p) => p.name).filter((n): n is string => typeof n === 'string' && n.trim().length >= MIN_DEDUPE_NAME_LENGTH)

  const pinned = pinnedEntries(profileEmployment)
  const rolesPerCompany = new Map<string, number>()
  for (const e of Array.isArray(profileEmployment) ? (profileEmployment as Employment[]) : []) {
    rolesPerCompany.set(companyKey(e?.company), (rolesPerCompany.get(companyKey(e?.company)) ?? 0) + 1)
  }
  const fromModel = (out.employment ?? [])
    .filter((e) => !pinned.some((p) => copiesPinned(e, p, rolesPerCompany)))
    .map(({ pinned: _modelFlag, ...e }) => e as Employment)
  const emitted: Employment[] = [...fromModel, ...pinned.map((p) => ({ ...structuredClone(p), pinned: true }))]

  // Most recent first, so the first entry gets the larger bullet budget.
  const employment = emitted.sort((x, y) => String(y.start_date ?? '').localeCompare(String(x.start_date ?? '')))
  out.employment = employment.map((e, i) => {
    if (e.pinned) return e
    let bullets = cleanList(e.bullets, Number.MAX_SAFE_INTEGER)
    if (SELF_EMPLOYED_RE.test(e.company ?? '')) {
      // Projects already carry these products; don't spend the budget twice.
      const distinct = bullets.filter((bl) => !featuredNames.some((n) => mentions(bl, n)))
      if (distinct.length) bullets = distinct
      else bullets = bullets.slice(0, 1)
    }
    return { ...e, bullets: bullets.slice(0, i === 0 ? b.mostRecentRoleBullets : b.otherRoleBullets) }
  })

  if (Array.isArray(out.skills) && out.skills.some((s) => typeof s === 'object' && s !== null)) {
    out.skills = (out.skills as Skill[]).slice(0, b.skillRows)
  }

  return out
}
