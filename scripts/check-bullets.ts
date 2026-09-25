/**
 * Review the profile's stored employment bullets for the STAR/XYZ shape (#298).
 *
 *   npm run check:bullets
 *
 * `/resume` only selects and lightly adapts these bullets, so whether a
 * generated résumé states results is decided here, in the source. This runs
 * the LLM judge once over every role (pinned roles included, since they are
 * owner-written content too) and lists the bullets that don't state a result,
 * with the reason. It reads the profile only; nothing is written.
 *
 * On demand; makes one live model call per role.
 */

import './eval/eval-env.js'
import { fetchProfile } from '../src/lib/profile-cache.js'
import { judgeStarBullets, STAR_JUDGE_MODEL } from './eval/star-judge.js'

interface Role {
  company?: string
  title?: string
  pinned?: boolean
  bullets?: unknown
}

async function main(): Promise<void> {
  const result = await fetchProfile()
  if (result.kind !== 'ok') {
    process.stderr.write(`Could not load the profile: ${result.kind}\n`)
    process.exit(2)
  }
  const roles = ((result.profile as { employment?: Role[] }).employment ?? []).filter((r) => Array.isArray(r?.bullets))

  process.stdout.write(`STAR/XYZ review of stored employment bullets (judge: ${STAR_JUDGE_MODEL})\n`)
  let total = 0
  let counted = 0
  for (const role of roles) {
    const bullets = (role.bullets as unknown[]).filter((b): b is string => typeof b === 'string')
    const label = `${role.company ?? '(no company)'} — ${role.title ?? ''}${role.pinned ? ' [pinned]' : ''}`
    try {
      const v = await judgeStarBullets(bullets)
      total += v.total
      counted += v.counted
      process.stdout.write(`\n${label}: ${v.counted}/${v.total} state a result\n`)
      for (const m of v.misses) process.stdout.write(`  - "${m.bullet}"\n    ${m.reason}\n`)
    } catch (err) {
      process.stdout.write(`\n${label}: judge unavailable — ${(err as Error).message}\n`)
    }
  }
  process.stdout.write(`\nOverall: ${counted}/${total} bullets state a result\n`)
}

main().catch((err) => {
  process.stderr.write(`check:bullets crashed: ${(err as Error).message}\n`)
  process.exit(2)
})
