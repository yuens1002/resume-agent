import { generateText } from 'ai'
import { getModel } from './ai.js'
import { supabase } from './supabase.js'
import { parseJSON } from './parse-json.js'
import type { MatchResponse, MatchScoring } from '../types.js'

const MATCH_MODEL = process.env.MATCH_MODEL ?? 'claude-sonnet-4-6'

export class ProfileNotFoundError extends Error {
  constructor() { super('Profile not found') }
}

interface RawScores {
  required_skills_extracted: string[]
  skills: { matched: string[]; partial: string[]; missing: string[] }
  experience: { years: number; scope: number; recency: number }
  domain: { industry: number; product_type: number; scale: number }
  verdict: string
}

function isValidRawScores(s: unknown): s is RawScores {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  return (
    Array.isArray(o.required_skills_extracted) &&
    o.skills != null && typeof o.skills === 'object' &&
    o.experience != null && typeof o.experience === 'object' &&
    o.domain != null && typeof o.domain === 'object' &&
    typeof o.verdict === 'string'
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

const SCORING_RUBRIC = `You are a precise job fit evaluator. Extract requirements from the job description and score the candidate profile against them using only the discrete values defined below.

--- SCORING RUBRIC ---

SKILLS
For each skill explicitly marked as REQUIRED in the JD (ignore preferred/nice-to-have):
- matched (1.0): directly present in candidate profile
- partial (0.5): adjacent technology (e.g. Vue when React required, MySQL when Postgres required)
- missing (0.0): absent from profile

EXPERIENCE — score each sub-factor independently:
- years:    meets or exceeds required (1.0) | 1-2 years short (0.7) | 3-4 years short (0.4) | significantly under (0.1)
- scope:    IC/lead/manager alignment — exact match (1.0) | similar (0.7) | different (0.3)
- recency:  relevant exp is current/last role (1.0) | within 3 yrs (0.7) | 3-5 yrs ago (0.4) | 5+ yrs ago (0.1)

DOMAIN — score each sub-factor independently:
- industry:      same industry (1.0) | adjacent (0.6) | different (0.3)
- product_type:  same product category (1.0) | similar (0.7) | different (0.3)
- scale:         company/product scale matches (1.0) | similar (0.7) | different (0.4)

--- OUTPUT ---

Respond ONLY with valid JSON. No prose, no markdown fences.

{
  "required_skills_extracted": ["skill1", "skill2"],
  "skills": {
    "matched": ["skill1"],
    "partial": ["skill2"],
    "missing": ["skill3"]
  },
  "experience": { "years": 0.7, "scope": 1.0, "recency": 1.0 },
  "domain": { "industry": 0.6, "product_type": 1.0, "scale": 0.7 },
  "verdict": "one sentence explaining the overall fit honestly"
}`

// Returns MatchResponse on success, null on model/parse failure, throws ProfileNotFoundError if profile is missing.
export async function scoreMatch(
  jobDescription: string,
  callerHint?: string,
): Promise<MatchResponse | null> {
  const { data: profile, error } = await supabase
    .from('public_profile')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single()

  if (error || !profile) throw new ProfileNotFoundError()

  const systemPrompt = callerHint
    ? `${SCORING_RUBRIC}\n\nCaller context: ${callerHint}`
    : SCORING_RUBRIC

  let raw: string
  try {
    const result = await generateText({
      model: getModel(MATCH_MODEL),
      maxTokens: 1024,
      system: systemPrompt,
      prompt: `Candidate profile:\n${JSON.stringify(profile, null, 2)}\n\nJob description:\n${jobDescription}`,
    })
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

  const total_required = scores.required_skills_extracted.length || 1
  const skills_score =
    (scores.skills.matched.length * 1.0 + scores.skills.partial.length * 0.5) / total_required

  const { years, scope, recency } = scores.experience
  const exp_score = (years + scope + recency) / 3

  const { industry, product_type, scale } = scores.domain
  const domain_score = (industry + product_type + scale) / 3

  const fit_score = round2(0.5 * skills_score + 0.3 * exp_score + 0.2 * domain_score)

  const recommended_action: MatchResponse['recommended_action'] =
    fit_score >= 0.8 ? 'apply' : fit_score >= 0.6 ? 'apply-with-tailoring' : 'pass'

  const scoring: MatchScoring = {
    skills: {
      matched: scores.skills.matched,
      partial: scores.skills.partial,
      missing: scores.skills.missing,
      score: round2(skills_score),
    },
    experience: { years, scope, recency, score: round2(exp_score) },
    domain: { industry, product_type, scale, score: round2(domain_score) },
  }

  return {
    fit_score,
    matched: scores.skills.matched,
    gaps: [
      ...scores.skills.missing,
      ...scores.skills.partial.map((s) => `${s} (partial)`),
    ],
    verdict: scores.verdict,
    recommended_action,
    scoring,
  }
}
