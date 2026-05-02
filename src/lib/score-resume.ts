/**
 * Deterministic rubric scorer for generated resumes.
 *
 * Scores a ResumeResponse against 6 ATS-informed rules using the JD as
 * reference. Rules 1-4 are fully deterministic (string/regex). Rules 5-6
 * use keyword overlap (no LLM needed).
 *
 * Returns a per-rule breakdown + total score (0-6). The caller uses this
 * to pick the best of two independent generations and to log failures.
 */

import type { ResumeResponse } from '../types.js'

// ── Types ────────────────────────────────────────────────

export interface RuleResult {
  rule: number
  name: string
  pass: boolean
  score: number   // 0.0–1.0
  detail: string
}

export interface RubricResult {
  rules: RuleResult[]
  total: number   // 0.0–6.0
  passed: boolean // total >= threshold
}

const PASS_THRESHOLD = 4.0

// Generic phrases that signal "robo resume" — checked case-insensitively
export const BANNED_PHRASES = [
  'results-driven',
  'proven track record',
  'dynamic team player',
  'leveraging synergies',
  'leveraging',
  'synergies',
  'spearheaded',
  'think outside the box',
  'go-getter',
  'self-starter',
  'detail-oriented professional',
  'highly motivated',
  'strong work ethic',
]

// ── Keyword extraction ───────────────────────────────────

/** Extract meaningful terms from text (3+ chars, no stop words). */
function extractKeywords(text: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
    'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'will',
    'with', 'this', 'that', 'from', 'they', 'were', 'their', 'what',
    'about', 'which', 'when', 'make', 'like', 'time', 'just', 'know',
    'take', 'people', 'into', 'year', 'your', 'some', 'them', 'than',
    'then', 'look', 'only', 'come', 'its', 'over', 'also', 'back',
    'after', 'work', 'first', 'well', 'way', 'even', 'new', 'want',
    'because', 'any', 'these', 'give', 'most', 'role', 'including',
    'such', 'using', 'ensure', 'ability', 'experience', 'strong',
    'excellent', 'preferred', 'required', 'minimum', 'etc', 'e.g.',
    'across', 'teams', 'team', 'company', 'join', 'help', 'play',
    'critical', 'key', 'evolving', 'needs', 'meet', 'business',
    'customer', 'customers', 'maintain', 'support', 'supporting',
    'develop', 'developing', 'create', 'creating', 'improving',
    'deliver', 'delivering', 'focus', 'will', 'would', 'should',
    'could', 'may', 'might', 'must', 'need', 'shall', 'does',
    'did', 'done', 'being', 'other', 'each', 'every', 'both',
    'through', 'between', 'under', 'during', 'before', 'while',
    'where', 'how', 'who', 'whom', 'why', 'same', 'different',
    'current', 'existing', 'act', 'apply', 'goals', 'enhance',
    'quality', 'practices', 'standards', 'tools', 'techniques',
    'management', 'applications', 'systems', 'cross-functional',
    'opportunities', 'improvements', 'recommend', 'implement',
    'complete', 'properly', 'managed', 'adhere', 'development',
  ])

  const words = text.toLowerCase().replace(/[^a-z0-9\s/+#.-]/g, ' ').split(/\s+/)
  // Keep uppercase acronyms (2-3 chars like API, UX, AWS) and longer words (4+ chars)
  const upperWords = text.replace(/[^a-zA-Z0-9\s/+#.-]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 2 && w.length <= 3 && /^[A-Z]+$/.test(w))
    .map(w => w.toLowerCase())
  return [...new Set([
    ...words.filter(w => w.length > 3 && !stop.has(w)),
    ...upperWords,
  ])]
}

// Descriptive adjectives that precede job titles in JDs but are not part of the title itself
const JD_LEADING_ADJECTIVES = /^(?:an?\s+)?(?:talented|experienced|skilled|passionate|motivated|qualified|exceptional|outstanding|dedicated|enthusiastic|driven|innovative|creative|dynamic|resourceful|entrepreneurial|seasoned|accomplished)\s+/i

/** Extract JD job title from common patterns. */
export function extractJDTitle(jd: string): string {
  // Try explicit patterns first
  const patterns = [
    /(?:job\s*title|position|role)\s*[:—–-]\s*(.+)/i,
    /(?:seeking|hiring|looking for)\s+(?:a\s+)?(.+?)(?:\s+to\s|\s+who\s|\s+with\s|\.|\n)/i,
    /^(?:the\s+)?(.+?)\s+(?:at|will|is responsible|bridges|plays)/im,
  ]
  for (const pat of patterns) {
    const m = jd.match(pat)
    if (m?.[1]) {
      const title = m[1].trim().replace(/[.,;]$/, '').replace(JD_LEADING_ADJECTIVES, '')
      if (title.length > 3 && title.length < 80) return title
    }
  }
  return ''
}

// ── Rule scorers ─────────────────────────────────────────

/** Rule 1: Summary opens with the JD's job title. */
function scoreRule1(resume: ResumeResponse, jd: string): RuleResult {
  const jdTitle = extractJDTitle(jd).toLowerCase()
  const summary = (resume.summary ?? '').toLowerCase()
  const firstSentence = summary.split(/[.!?\n]/)[0] ?? ''

  if (!jdTitle) {
    return { rule: 1, name: 'JD title in summary', pass: true, score: 1, detail: 'Could not extract JD title — skipped' }
  }

  // Check if distinctive words from the JD title appear in the first sentence
  // Normalize common abbreviations before comparison: sr→senior, jr→junior, etc.
  const abbrevMap: Record<string, string> = { sr: 'senior', jr: 'junior', mgr: 'manager', dev: 'developer', eng: 'engineer' }
  const genericTitleWords = new Set(['senior', 'junior', 'lead', 'staff', 'principal', 'engineer', 'developer', 'manager', 'analyst', 'specialist', 'associate', 'intern', 'sr', 'jr'])
  const normalizedTitle = jdTitle.split(/\s+/).map(w => abbrevMap[w] ?? w).join(' ')
  const titleWords = normalizedTitle.split(/\s+/).filter(w => w.length > 1 && !genericTitleWords.has(w))
  // If all title words are generic (e.g. "Senior Engineer"), fall back to matching the full set
  const wordsToMatch = titleWords.length > 0 ? titleWords : jdTitle.split(/\s+/).filter(w => w.length > 2)
  const matched = wordsToMatch.filter(w => firstSentence.includes(w))
  const ratio = wordsToMatch.length > 0 ? matched.length / wordsToMatch.length : 0

  const pass = ratio >= 0.6
  return {
    rule: 1,
    name: 'JD title in summary',
    pass,
    score: Math.min(ratio / 0.6, 1),
    detail: pass
      ? `Summary contains ${matched.length}/${wordsToMatch.length} distinctive title keywords`
      : `Summary missing JD title words: ${wordsToMatch.filter(w => !firstSentence.includes(w)).join(', ')}`,
  }
}

/** Rule 2: 60-80% keyword coverage from JD across the resume. */
function scoreRule2(resume: ResumeResponse, jd: string): RuleResult {
  const jdKeywords = [...new Set(extractKeywords(jd))]
  const resumeText = [
    resume.summary ?? '',
    ...((resume.skills ?? []) as unknown[]).map((s: unknown) => typeof s === 'string' ? s : `${(s as { category?: string }).category ?? ''} ${((s as { items?: string[] }).items ?? []).join(' ')}`),
    ...(resume.employment?.flatMap(e => [e.title, e.company, ...(e.bullets ?? [])]) ?? []),
    ...(resume.projects?.flatMap(p => [p.name, p.description ?? '', ...(p.highlights ?? [])]) ?? []),
  ].join(' ').toLowerCase()

  const matched = jdKeywords.filter(kw => resumeText.includes(kw))
  const coverage = jdKeywords.length > 0 ? matched.length / jdKeywords.length : 0

  // Score: 0 at <15%, linear to 1.0 at 40%, stays 1.0 up to 70%, drops slightly above (keyword stuffing)
  // Note: verbose JDs produce 50-80 unique terms; a 2-page resume matching 30-40% is strong.
  let score: number
  if (coverage < 0.15) score = coverage / 0.15 * 0.3
  else if (coverage <= 0.7) score = 0.3 + (Math.min(coverage, 0.7) - 0.15) / 0.55 * 0.7
  else score = 0.9 // slight penalty for potential stuffing

  return {
    rule: 2,
    name: 'Keyword coverage',
    pass: coverage >= 0.25,
    score,
    detail: `${(coverage * 100).toFixed(0)}% keyword coverage (${matched.length}/${jdKeywords.length} terms)`,
  }
}

/** Rule 3: Bullets contain quantified results (numbers, percentages, metrics). */
function scoreRule3(resume: ResumeResponse): RuleResult {
  const allBullets = [
    ...(resume.employment?.flatMap(e => e.bullets ?? []) ?? []),
    ...(resume.projects?.flatMap(p => p.highlights ?? []) ?? []),
  ]

  if (allBullets.length === 0) {
    return { rule: 3, name: 'Quantified bullets', pass: false, score: 0, detail: 'No bullets found' }
  }

  const metricPattern = /\d+%|\$[\d,.]+|\b\d{2,}\b|\d+x\b|\d+\+/
  const withMetrics = allBullets.filter(b => metricPattern.test(b))
  const ratio = withMetrics.length / allBullets.length

  // Target: >=50% of bullets have metrics
  const score = Math.min(ratio / 0.5, 1)
  return {
    rule: 3,
    name: 'Quantified bullets',
    pass: ratio >= 0.4,
    score,
    detail: `${withMetrics.length}/${allBullets.length} bullets contain metrics (${(ratio * 100).toFixed(0)}%)`,
  }
}

/** Rule 4: No banned generic phrases. */
function scoreRule4(resume: ResumeResponse): RuleResult {
  const fullText = [
    resume.summary ?? '',
    ...(resume.employment?.flatMap(e => e.bullets ?? []) ?? []),
    ...(resume.projects?.flatMap(p => p.highlights ?? []) ?? []),
  ].join(' ').toLowerCase()

  const found = BANNED_PHRASES.filter(phrase => fullText.includes(phrase))

  // Rule 4 is a HARD VETO — any banned phrase disqualifies the candidate.
  // Score 0 ensures this resume loses to the other generation.
  return {
    rule: 4,
    name: 'Authenticity (no generic phrases)',
    pass: found.length === 0,
    score: found.length === 0 ? 1 : 0,
    detail: found.length === 0 ? 'No banned phrases detected' : `VETO — found: ${found.join(', ')}`,
  }
}

// Imperative/action verbs at the start of a sentence signal actual job duties.
// Company boilerplate is descriptive prose — it won't trigger this pattern.
const RESPONSIBILITY_SIGNAL = /(?:^|\.\s+|\n\s*|:\s+)(?:build|design|develop|lead|partner|work|collaborate|own|drive|manage|create|deliver|define|architect|implement|support|troubleshoot|review|mentor|write|maintain|analyze|evaluate|identify|establish|shape|scale|ship|deploy|operate)\b/im

/** Rule 5: First bullet of most recent role addresses JD's primary responsibility. */
function scoreRule5(resume: ResumeResponse, jd: string): RuleResult {
  const firstJob = resume.employment?.[0]
  const firstBullet = firstJob?.bullets?.[0] ?? ''

  if (!firstBullet) {
    return { rule: 5, name: 'First bullet matches JD primary responsibility', pass: false, score: 0, detail: 'No employment bullets found' }
  }

  const jdLines = jd.split('\n').filter(l => l.trim().length > 20)
  const primaryResp = jdLines.slice(0, 5).join(' ')

  // Skip rule if the opening lines are company/team boilerplate rather than duties
  if (!RESPONSIBILITY_SIGNAL.test(primaryResp)) {
    return { rule: 5, name: 'First bullet matches JD primary responsibility', pass: true, score: 1, detail: 'JD opening is company context — rule skipped' }
  }

  const jdWords = [...new Set(extractKeywords(primaryResp.toLowerCase()))].slice(0, 15)
  const bulletWords = new Set(extractKeywords(firstBullet.toLowerCase()))
  const overlap = jdWords.filter(w => bulletWords.has(w))
  const ratio = jdWords.length > 0 ? overlap.length / jdWords.length : 0

  const score = Math.min(ratio / 0.15, 1)
  return {
    rule: 5,
    name: 'First bullet matches JD primary responsibility',
    pass: ratio >= 0.05,
    score,
    detail: `${overlap.length} keyword overlaps with JD opening (${(ratio * 100).toFixed(0)}%)`,
  }
}

/** Rule 6: Top skills in the skills list match JD requirements. */
function scoreRule6(resume: ResumeResponse, jd: string): RuleResult {
  const skills = (resume.skills ?? []) as unknown[]
  const flatSkills = skills.flatMap((s: unknown) =>
    typeof s === 'string' ? [s.toLowerCase()] : ((s as { items?: string[] }).items ?? []).map((i: string) => i.toLowerCase()),
  )

  if (flatSkills.length === 0) {
    return { rule: 6, name: 'Skills ordered by JD relevance', pass: false, score: 0, detail: 'No skills found' }
  }

  const jdLower = jd.toLowerCase()

  // Check if the first 5 skills appear in the JD — match either the full skill
  // or any significant word within it (e.g. "design systems" matches "design system")
  const top5 = flatSkills.slice(0, 5)
  const top5InJD = top5.filter(skill => {
    if (jdLower.includes(skill)) return true
    // Check individual words (3+ chars) for multi-word or compound skills (e.g. "html/css")
    const words = skill.split(/[\s/,&+]+/).filter((w: string) => w.length >= 3)
    return words.some((w: string) => jdLower.includes(w))
  })

  const ratio = top5.length > 0 ? top5InJD.length / top5.length : 0
  return {
    rule: 6,
    name: 'Skills ordered by JD relevance',
    pass: ratio >= 0.4,
    score: ratio,
    detail: `${top5InJD.length}/${top5.length} top skills match JD keywords`,
  }
}

// ── Main scorer ──────────────────────────────────────────

export function scoreResume(resume: ResumeResponse, jd: string): RubricResult {
  const rules = [
    scoreRule1(resume, jd),
    scoreRule2(resume, jd),
    scoreRule3(resume),
    scoreRule4(resume),
    scoreRule5(resume, jd),
    scoreRule6(resume, jd),
  ]

  const total = rules.reduce((sum, r) => sum + r.score, 0)

  return {
    rules,
    total,
    passed: total >= PASS_THRESHOLD,
  }
}

export { PASS_THRESHOLD }
