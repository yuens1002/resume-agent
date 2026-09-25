/**
 * LLM judge for the STAR/XYZ bullet shape (#298).
 *
 * A regex can't tell a result from an intention ("to improve onboarding"),
 * so STAR/XYZ is judged by a model. It is used only off the request path:
 * report-only in `npm run eval:resume`, and by `npm run check:bullets` to
 * review the profile's stored bullets. It never runs during `/resume`.
 *
 * The judge returns reasons for misses only, which keeps output tokens (and
 * so cost and latency) low.
 */

import { generateText } from 'ai'
import { getModel } from '../../src/lib/ai.js'
import { parseJSON } from '../../src/lib/parse-json.js'

export const STAR_JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? 'anthropic/claude-sonnet-4.5'

export interface StarMiss {
  bullet: string
  reason: string
}

export interface StarVerdict {
  total: number
  counted: number
  misses: StarMiss[]
}

export function buildStarJudgePrompt(bullets: string[]): string {
  return `You judge résumé bullets for the STAR/XYZ shape: "accomplished [X], as measured by [Y], by doing [Z]".

A bullet COUNTS only if it opens with a past-tense action verb AND states a concrete result that actually happened. A result does not have to be a number. Any of these counts:
- a metric or a before→after change
- the scale of what was delivered or held (how many services, users, teams or people)
- a commitment that was met: a schedule, cadence, deadline or SLA that was kept
- who or what it served, was adopted by, or enabled to do something they couldn't before
- what it replaced, or an end state it reached

A bullet does NOT count if its "result" is only an intention ("to improve onboarding", "to drive adoption"), a vague claim ("improving things", "significantly"), or if it only describes a duty or the technologies used.
Judge meaning, not keywords. Don't reward length. Don't demand a number when one of the non-numeric results above is clearly stated.

Bullets:
${bullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Reply with JSON only, listing ONLY the bullets that do NOT count: {"misses":[{"n":2,"reason":"<under 12 words>"}]}. Use {"misses":[]} if every bullet counts.`
}

/**
 * Judge `bullets` in one call. Throws on a failed call or a malformed reply,
 * so callers can report it rather than silently treating it as a pass.
 */
export async function judgeStarBullets(bullets: string[]): Promise<StarVerdict> {
  if (!bullets.length) return { total: 0, counted: 0, misses: [] }
  const { text } = await generateText({
    model: getModel(STAR_JUDGE_MODEL),
    maxTokens: 1000,
    temperature: 0,
    prompt: buildStarJudgePrompt(bullets),
  })
  const parsed = parseJSON(text) as { misses?: Array<{ n?: unknown; reason?: unknown }> }
  if (!parsed || !Array.isArray(parsed.misses)) throw new Error('judge reply had no "misses" array')
  const seen = new Set<number>()
  const misses: StarMiss[] = []
  for (const m of parsed.misses) {
    const n = Number(m?.n)
    if (!Number.isInteger(n) || n < 1 || n > bullets.length || seen.has(n)) {
      throw new Error(`judge returned an invalid bullet number: ${String(m?.n)}`)
    }
    seen.add(n)
    misses.push({ bullet: bullets[n - 1], reason: typeof m?.reason === 'string' ? m.reason : 'no reason given' })
  }
  return { total: bullets.length, counted: bullets.length - misses.length, misses }
}
