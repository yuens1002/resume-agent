/**
 * Post-filter: strip banned phrases from the winning resume.
 *
 * This is a safety net on top of Rule 4. If both LLM candidates produce
 * banned phrases (so the hard-veto can't distinguish them), this filter
 * removes or neutralises the phrases before the response ships.
 *
 * Replacements preserve grammatical structure where possible.
 */

import type { ResumeResponse } from '../types.js'
import { BANNED_PHRASES } from './score-resume.js'

/** Neutral replacements — phrase → substitute (empty string = delete) */
const REPLACEMENTS: Record<string, string> = {
  'proven track record':        'track record',
  'leveraging synergies':       'using collaboration',
  'leveraging':                 'using',
  'spearheaded':                'led',
  'synergies':                  'collaboration',
  'results-driven':             '',
  'dynamic team player':        'collaborative',
  'think outside the box':      '',
  'go-getter':                  '',
  'self-starter':               '',
  'detail-oriented professional': '',
  'highly motivated':           '',
  'strong work ethic':          '',
}

/**
 * Build a single regex that matches any banned phrase (case-insensitive).
 * Longer phrases are tested first so "leveraging synergies" matches before
 * the shorter "leveraging".
 */
const BANNED_RE = new RegExp(
  BANNED_PHRASES
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'gi',
)

/** Replace a single match, preserving leading capitalisation. */
function replaceBanned(text: string): string {
  return text
    .replace(BANNED_RE, (match) => {
      const key = match.toLowerCase()
      const replacement = REPLACEMENTS[key] ?? ''
      if (!replacement) return ''
      // Preserve capitalisation: if the original started uppercase, capitalise replacement
      if (match[0] === match[0].toUpperCase()) {
        return replacement[0].toUpperCase() + replacement.slice(1)
      }
      return replacement
    })
    .replace(/ {2,}/g, ' ')
    .replace(/^ | $/gm, '')
}

/** Deep-scan all text fields in a resume and strip banned phrases. */
export function stripBannedPhrases(resume: ResumeResponse): ResumeResponse {
  const out: ResumeResponse = structuredClone(resume)

  // Summary
  if (out.summary) {
    out.summary = replaceBanned(out.summary)
  }

  // Employment bullets
  for (const emp of out.employment ?? []) {
    emp.bullets = emp.bullets.map(replaceBanned)
  }

  // Project highlights
  for (const proj of out.projects ?? []) {
    proj.highlights = proj.highlights.map(replaceBanned)
  }

  return out
}
