/**
 * Deterministic format + content-budget pass over a generated resume (#298).
 *
 * Runs after stripBannedPhrases and before scoring, so the rubric scores what
 * actually ships. It only removes or rewords — it never adds content, and
 * never adds a number the model didn't write.
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

/** Trailing periods off, a standalone "&" spelled out. "R&D"-style names are untouched. */
export function cleanBullet(text: string): string {
  return text
    .trim()
    .replace(/\s+&\s+/g, ' and ')
    .replace(/\.+$/, '')
    .trim()
}

/** The first `max` sentences. A period inside a token (Node.js, 3.5x) is not a sentence end. */
export function capSentences(text: string, max: number): string {
  const sentences = text.trim().split(/(?<=[.!?])\s+(?=[A-Z])/)
  return sentences.slice(0, max).join(' ')
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

/** Profile employment entries the owner pinned (`pinned: true`), keyed by normalized company. */
function pinnedByCompany(profileEmployment: unknown): Map<string, Employment> {
  const out = new Map<string, Employment>()
  if (!Array.isArray(profileEmployment)) return out
  for (const e of profileEmployment as Employment[]) {
    if (e?.pinned === true && Array.isArray(e.bullets)) out.set(companyKey(e.company), e)
  }
  return out
}

/**
 * `profileEmployment` is the profile's employment array. Entries pinned there
 * (#298 D9) are emitted with the profile's bullets verbatim and in order —
 * whatever the model returned — and are exempt from caps and dedupe. A pinned
 * entry the model dropped is restored.
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

  const pinned = pinnedByCompany(profileEmployment)
  const profileCompanies = new Set(
    (Array.isArray(profileEmployment) ? (profileEmployment as Employment[]) : []).map((p) => companyKey(p?.company)),
  )
  // Match a pinned role by company. Only an entry whose company is unknown to
  // the profile (the model renamed it) falls back to matching by start date,
  // so a different real role that started the same month is never swallowed.
  const pinFor = (e: Employment) => pinned.get(companyKey(e.company)) ??
    (profileCompanies.has(companyKey(e.company))
      ? undefined
      : [...pinned.values()].find((p) => p.start_date && p.start_date === e.start_date))
  const emitted = [...(out.employment ?? [])]
  for (const entry of pinned.values()) {
    if (!emitted.some((e) => pinFor(e) === entry)) emitted.push(structuredClone(entry))
  }

  // Most recent first, so the first entry gets the larger bullet budget.
  const employment = emitted.sort((x, y) => String(y.start_date ?? '').localeCompare(String(x.start_date ?? '')))
  out.employment = employment.map((e, i) => {
    const pin = pinFor(e)
    if (pin) return { ...e, company: pin.company, title: pin.title, pinned: true, bullets: [...pin.bullets] }
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
