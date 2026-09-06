import type { Context } from 'hono'

export type CallerType = 'ats' | 'recruiter' | 'hiring-manager' | 'personal-ai' | 'human' | 'unknown'

export interface CallerProfile {
  type: CallerType
  hint: string // passed to Claude as context
}

const ATS_AGENTS = ['greenhouse', 'lever', 'workday', 'icims', 'taleo', 'jobvite', 'smartrecruiters', 'ashby']
const AI_AGENTS = ['gptbot', 'claudebot', 'claude', 'chatgpt', 'gemini', 'copilot', 'openai', 'anthropic', 'perplexity']

/**
 * Every caller hint this module can emit.
 *
 * Extracted from the inline literals they used to be for two reasons: the ATS
 * hint appeared twice verbatim (explicit header and user-agent inference), and
 * tests that need the real strings were reduced to regex-parsing this file,
 * which coupled them to its quoting style rather than its behaviour. The
 * strings are byte-identical to what shipped before.
 *
 * Length matters to more than tone: these are the base a caller's
 * `; shown_projects: <slugs>` suffix is appended to, and #254 turned on where
 * that suffix lands relative to the response cache key.
 */
export const CALLER_HINTS = {
  ats: 'ATS system performing automated candidate screening. Be concise, structured, and decisive.',
  recruiter: 'Recruiter reviewing candidates. Be clear, narrative, and highlight standout qualities.',
  hiringManager: 'Hiring manager evaluating technical fit. Be specific, include depth on technical skills and project scope.',
  personalAi: 'Personal AI assistant querying on behalf of the candidate. Full detail, no hedging.',
  human: 'Human visitor browsing the portfolio. Be concise and conversational.',
  aiAgent: 'AI assistant querying on behalf of a user. Be thorough and machine-readable.',
  unknown: 'Unknown caller. Balance structure and readability. Be honest and direct.',
  atsShortQuery: 'Short structured query suggesting ATS screening. Be concise and decisive.',
  hiringManagerTechnical: 'Technical depth question suggesting hiring manager. Include specifics and scope.',
} as const

/** Flat list of the distinct hints above, for tests and analysis. */
export const ALL_CALLER_HINTS: readonly string[] = [...new Set(Object.values(CALLER_HINTS))]
export function detectCaller(c: Context): CallerProfile {
  const ua = (c.req.header('user-agent') ?? '').toLowerCase()
  const agentType = (c.req.header('x-agent-type') ?? '').toLowerCase()
  const explicitContext = c.req.header('x-caller-context') ?? ''

  // Explicit declaration takes priority
  if (agentType === 'ats') return { type: 'ats', hint: CALLER_HINTS.ats }
  if (agentType === 'recruiter') return { type: 'recruiter', hint: CALLER_HINTS.recruiter }
  if (agentType === 'hiring-manager') return { type: 'hiring-manager', hint: CALLER_HINTS.hiringManager }
  if (agentType === 'personal-ai') return { type: 'personal-ai', hint: CALLER_HINTS.personalAi }
  if (agentType === 'human') return { type: 'human', hint: CALLER_HINTS.human }
  if (explicitContext) return { type: 'unknown', hint: explicitContext }

  // Infer from User-Agent
  if (ATS_AGENTS.some(a => ua.includes(a))) {
    return { type: 'ats', hint: CALLER_HINTS.ats }
  }

  if (AI_AGENTS.some(a => ua.includes(a))) {
    return { type: 'personal-ai', hint: CALLER_HINTS.aiAgent }
  }

  // Infer from query language (passed in separately for /query route)
  return { type: 'unknown', hint: CALLER_HINTS.unknown }
}

export function callerContextFromQuery(question: string): Partial<CallerProfile> {
  const q = question.toLowerCase()

  // Terse, boolean-style questions suggest ATS
  if (q.split(' ').length < 12 && (q.includes('does') || q.includes('has') || q.includes('is') || q.includes('can'))) {
    return { type: 'ats', hint: CALLER_HINTS.atsShortQuery }
  }

  // Technical depth questions suggest hiring manager
  if (q.includes('architect') || q.includes('scale') || q.includes('production') || q.includes('trade-off') || q.includes('design')) {
    return { type: 'hiring-manager', hint: CALLER_HINTS.hiringManagerTechnical }
  }

  return {}
}
