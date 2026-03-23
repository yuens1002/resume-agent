import type { Context } from 'hono'

export type CallerType = 'ats' | 'recruiter' | 'hiring-manager' | 'personal-ai' | 'unknown'

export interface CallerProfile {
  type: CallerType
  hint: string // passed to Claude as context
}

const ATS_AGENTS = ['greenhouse', 'lever', 'workday', 'icims', 'taleo', 'jobvite', 'smartrecruiters', 'ashby']
const AI_AGENTS = ['gptbot', 'claudebot', 'claude', 'chatgpt', 'gemini', 'copilot', 'openai', 'anthropic', 'perplexity']

export function detectCaller(c: Context): CallerProfile {
  const ua = (c.req.header('user-agent') ?? '').toLowerCase()
  const agentType = (c.req.header('x-agent-type') ?? '').toLowerCase()
  const explicitContext = c.req.header('x-caller-context') ?? ''

  // Explicit declaration takes priority
  if (agentType === 'ats') return { type: 'ats', hint: 'ATS system performing automated candidate screening. Be concise, structured, and decisive.' }
  if (agentType === 'recruiter') return { type: 'recruiter', hint: 'Recruiter reviewing candidates. Be clear, narrative, and highlight standout qualities.' }
  if (agentType === 'hiring-manager') return { type: 'hiring-manager', hint: 'Hiring manager evaluating technical fit. Be specific, include depth on technical skills and project scope.' }
  if (agentType === 'personal-ai') return { type: 'personal-ai', hint: 'Personal AI assistant querying on behalf of the candidate. Full detail, no hedging.' }
  if (explicitContext) return { type: 'unknown', hint: explicitContext }

  // Infer from User-Agent
  if (ATS_AGENTS.some(a => ua.includes(a))) {
    return { type: 'ats', hint: 'ATS system performing automated candidate screening. Be concise, structured, and decisive.' }
  }

  if (AI_AGENTS.some(a => ua.includes(a))) {
    return { type: 'personal-ai', hint: 'AI assistant querying on behalf of a user. Be thorough and machine-readable.' }
  }

  // Infer from query language (passed in separately for /query route)
  return { type: 'unknown', hint: 'Unknown caller. Balance structure and readability. Be honest and direct.' }
}

export function callerContextFromQuery(question: string): Partial<CallerProfile> {
  const q = question.toLowerCase()

  // Terse, boolean-style questions suggest ATS
  if (q.split(' ').length < 12 && (q.includes('does') || q.includes('has') || q.includes('is') || q.includes('can'))) {
    return { type: 'ats', hint: 'Short structured query suggesting ATS screening. Be concise and decisive.' }
  }

  // Technical depth questions suggest hiring manager
  if (q.includes('architect') || q.includes('scale') || q.includes('production') || q.includes('trade-off') || q.includes('design')) {
    return { type: 'hiring-manager', hint: 'Technical depth question suggesting hiring manager. Include specifics and scope.' }
  }

  return {}
}
