import { generateText } from 'ai'
import { getModel, generateWithLengthRetry } from './ai.js'
import { fetchProfile } from './profile-cache.js'
import { parseJSON } from './parse-json.js'
import type {
  MatchResponse,
  MatchScoring,
  MatchRequiredQuality,
  MatchScoredQuality,
  MatchQualityCategory,
  MatchQualityImportance,
  MatchQualityVerdict,
  MatchQualityEvidenceGrade,
} from '../types.js'

const MATCH_MODEL = process.env.MATCH_MODEL ?? 'google/gemma-4-26b-a4b'
const MATCH_MAX_TOKENS = 2048
// Must exceed MATCH_MAX_TOKENS — see generateWithLengthRetry's retryCeiling
// doc in ai.ts. A truncation retry at the same cap is a wasted duplicate call.
const MATCH_RETRY_CEILING = 4096

export class ProfileNotFoundError extends Error {
  constructor() { super('Profile not found') }
}

export class ProfileUnavailableError extends Error {
  constructor() { super('Profile temporarily unavailable') }
}

interface RawScores {
  required_qualities: MatchRequiredQuality[]
  scored_qualities: MatchScoredQuality[]
  verdict: string
}

function isCategory(v: unknown): v is MatchQualityCategory {
  return v === 'skill' || v === 'experience' || v === 'domain'
}
function isImportance(v: unknown): v is MatchQualityImportance {
  return v === 'must_have' || v === 'preferred'
}
function isVerdict(v: unknown): v is MatchQualityVerdict {
  return v === 'matched' || v === 'partial' || v === 'missing'
}
function isEvidenceGrade(v: unknown): v is MatchQualityEvidenceGrade {
  return v === 'verified' || v === 'claimed' || v === 'absent'
}

function isRequiredQuality(o: unknown): o is MatchRequiredQuality {
  if (!o || typeof o !== 'object') return false
  const r = o as Record<string, unknown>
  return typeof r.name === 'string' && isCategory(r.category) && isImportance(r.jd_importance)
}

function isScoredQuality(o: unknown): o is MatchScoredQuality {
  if (!o || typeof o !== 'object') return false
  const r = o as Record<string, unknown>
  return (
    typeof r.name === 'string' &&
    isCategory(r.category) &&
    isImportance(r.jd_importance) &&
    isVerdict(r.verdict) &&
    isEvidenceGrade(r.evidence_grade)
  )
}

function isValidRawScores(s: unknown): s is RawScores {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  return (
    Array.isArray(o.required_qualities) && o.required_qualities.every(isRequiredQuality) &&
    Array.isArray(o.scored_qualities) && o.scored_qualities.every(isScoredQuality) &&
    typeof o.verdict === 'string'
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Numeric-notation normalizer for JD text — collapses comma-grouped digits
 * and k/K-suffix shorthand ("50,000+" / "50k+") to a plain integer ("50000+")
 * before the JD reaches the model. Spike-tested (2026-08-12,
 * docs/plans/match-quality-extraction.md "Spike results" round 2): raw
 * notation variants already produced identical model behavior without this,
 * so it fixes no observed failure — kept anyway because it is a free,
 * deterministic, lossless transform that can only remove variance, never
 * introduce it. Deliberately does not touch spelled-out numbers or
 * descriptive phrasing ("fifty thousand", "tens-of-thousands-strong") — that
 * is open-ended natural language, not a bounded mechanical transform, and
 * belongs to the model's own judgment, not a regex (round 2/3 spikes: that
 * axis is where the real, measurable cross-model variance actually lives).
 */
export function normalizeNumericNotation(text: string): string {
  return text
    .replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) => m.replace(/,/g, ''))
    .replace(/\b(\d+(?:\.\d+)?)\s*[kK]\b/g, (_m, n) => String(Math.round(parseFloat(n) * 1000)))
}

const SCORING_RUBRIC = `You are a precise job fit evaluator. Read the job description and identify the qualities THIS employer actually cares about — do not assume a fixed checklist applies to every JD.

--- STEP 1: EXTRACT ---
List every quality (skill, experience characteristic, or domain characteristic) the JD explicitly states as a requirement or preference for the CANDIDATE. Do not extract a quality merely because it describes the COMPANY's context (e.g. company size, industry, funding stage, the company's own tech stack) — descriptive company context is not automatically a candidate requirement. Only extract company context if the JD also states or clearly asks that the candidate must have prior experience WITH that context (e.g. "must have worked at a company of this scale before," "healthcare domain experience required").

This context carve-out does NOT apply to the ROLE's scope or seniority — always extract role scope (individual contributor, tech lead, manager, "no direct reports," "manages a team of N") as an experience quality. Unlike company size or industry, the role's scope is inherently a statement about what the candidate will be doing day to day, not incidental company description — treat "individual contributor role" the same as any other stated requirement.

Do not invent qualities the JD never raises. For each:
- name: short label
- category: "skill" | "experience" | "domain"
- jd_importance: "must_have" (explicitly required) | "preferred" (nice-to-have, or the JD asks for it without making it mandatory)

--- STEP 2: SCORE ---
For each extracted quality, compare against the candidate profile (skills, employment history with dates, projects with git_evidence — commit counts, dates, signed provenance). Repeat jd_importance from Step 1 on each scored item — do not rely on the two lists being aligned by name or position:
- verdict: "matched" (candidate demonstrably has this) | "partial" (adjacent/close but not exact) | "missing" (no support found)
- evidence_grade: "verified" (backed by a dated project with git_evidence, or an unambiguous employment date range) | "claimed" (only supported by prose — a bullet point, a summary sentence — with no verifiable artifact) | "absent" (verdict is missing, so no evidence exists)

--- OUTPUT ---
Respond ONLY with valid JSON. No prose, no markdown fences.

{
  "required_qualities": [{"name": "...", "category": "skill|experience|domain", "jd_importance": "must_have|preferred"}],
  "scored_qualities": [{"name": "...", "category": "skill|experience|domain", "jd_importance": "must_have|preferred", "verdict": "matched|partial|missing", "evidence_grade": "verified|claimed|absent"}],
  "verdict": "one sentence explaining the overall fit honestly"
}`

const IMPORTANCE_WEIGHT: Record<MatchQualityImportance, number> = {
  must_have: 2,
  preferred: 1,
}

/**
 * Per-quality credit. `matched`/`partial` are discounted further when the
 * only support is prose (`claimed`) rather than a dated project with
 * `git_evidence` or an unambiguous employment range (`verified`) — the
 * live-derived evidence-weighing decision from
 * docs/plans/match-quality-extraction.md. `missing` always scores 0
 * regardless of `evidence_grade` (should be `absent`, but the table doesn't
 * depend on that field being self-consistent when it isn't).
 */
const CREDIT: Record<MatchQualityVerdict, Record<MatchQualityEvidenceGrade, number>> = {
  matched: { verified: 1.0, claimed: 0.8, absent: 0 },
  partial: { verified: 0.5, claimed: 0.4, absent: 0 },
  missing: { verified: 0, claimed: 0, absent: 0 },
}

/**
 * Weighted-average quality score, bounded 0..1 by construction — generalizes
 * `skillsScore`'s #240 fix (retired here; every category is now scored by
 * this one function, see docs/plans/match-quality-extraction.md Open Item 4)
 * from a uniform per-skill weight to a per-quality `jd_importance` weight,
 * and from a flat matched/partial/missing credit to one additionally scaled
 * by `evidence_grade`.
 *
 * `numerator` sums credit over `scoredQualities` only (what the model
 * actually classified). `denominator` is the `max` of the weight-sum implied
 * by `requiredQualities` (what the JD asked for) and the weight-sum implied
 * by `scoredQualities` (what got classified) — exactly #240's
 * `max(requiredCount, classifiedCount)` trick, generalized from a plain count
 * to a weighted sum. This bounds the score two ways: numerator ≤
 * scoredWeightSum ≤ denominator, so the ratio can never exceed 1; and if the
 * model silently drops a `must_have` item between extraction and scoring,
 * `requiredWeightSum` stays anchored to what was actually asked for, so the
 * omission still costs what it should instead of quietly raising the average
 * over survivors — the same failure #240 fixed for `skillsScore`, now
 * reachable through a differently-shaped list pair.
 */
export function qualityScore(
  requiredQualities: MatchRequiredQuality[],
  scoredQualities: MatchScoredQuality[],
): number {
  const requiredWeightSum = requiredQualities.reduce((sum, q) => sum + IMPORTANCE_WEIGHT[q.jd_importance], 0)
  const scoredWeightSum = scoredQualities.reduce((sum, q) => sum + IMPORTANCE_WEIGHT[q.jd_importance], 0)
  const numerator = scoredQualities.reduce(
    (sum, q) => sum + IMPORTANCE_WEIGHT[q.jd_importance] * CREDIT[q.verdict][q.evidence_grade],
    0,
  )
  const denominator = Math.max(requiredWeightSum, scoredWeightSum) || 1
  return numerator / denominator
}

// Returns MatchResponse on success, null on model/parse failure. Throws
// ProfileNotFoundError if the profile row is absent, ProfileUnavailableError
// if the data source is unreachable and no cached copy exists.
export async function scoreMatch(
  jobDescription: string,
  callerHint?: string,
  modelOverride?: string,
): Promise<MatchResponse | null> {
  const profileResult = await fetchProfile()

  if (profileResult.kind === 'not_found') throw new ProfileNotFoundError()
  if (profileResult.kind === 'unavailable') throw new ProfileUnavailableError()
  const profile = profileResult.profile

  const systemPrompt = callerHint
    ? `${SCORING_RUBRIC}\n\nCaller context: ${callerHint}`
    : SCORING_RUBRIC

  const prompt = `Candidate profile:\n${JSON.stringify(profile, null, 2)}\n\nJob description:\n${normalizeNumericNotation(jobDescription)}`

  let raw: string
  try {
    const result = await generateWithLengthRetry(
      (maxTokens) =>
        generateText({
          model: getModel(modelOverride ?? MATCH_MODEL),
          maxTokens,
          system: systemPrompt,
          prompt,
        }),
      MATCH_MAX_TOKENS,
      MATCH_RETRY_CEILING,
    )
    raw = result.text
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = parseJSON<unknown>(raw)
  } catch {
    return null
  }

  if (!isValidRawScores(parsed)) return null
  const scores = parsed

  const fit_score = round2(qualityScore(scores.required_qualities, scores.scored_qualities))

  const matched = scores.scored_qualities
    .filter((q) => q.category === 'skill' && q.verdict === 'matched')
    .map((q) => q.name)
  const gaps = scores.scored_qualities
    .filter((q) => q.category === 'skill' && q.verdict !== 'matched')
    .map((q) => (q.verdict === 'partial' ? `${q.name} (partial)` : q.name))

  const recommended_action: MatchResponse['recommended_action'] =
    fit_score >= 0.8 ? 'apply' : fit_score >= 0.6 ? 'apply-with-tailoring' : 'pass'

  const scoring: MatchScoring = {
    required_qualities: scores.required_qualities,
    scored_qualities: scores.scored_qualities,
  }

  return {
    fit_score,
    matched,
    gaps,
    verdict: scores.verdict,
    recommended_action,
    scoring,
  }
}
