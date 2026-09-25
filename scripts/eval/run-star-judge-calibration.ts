/**
 * Check the STAR/XYZ judge against its labeled calibration set (#298).
 *
 *   npm run eval:star-judge
 *
 * Judges each calibration bullet on its own (as check:bullets and the eval
 * would see a borderline case) and reports agreement with the owner's labels,
 * listing every disagreement. On demand; one live model call per bullet.
 */

import './eval-env.js'
import { judgeStarBullets, STAR_JUDGE_MODEL } from './star-judge.js'
import { STAR_CALIBRATION } from './star-judge-calibration.js'

async function main(): Promise<void> {
  process.stdout.write(`STAR/XYZ judge calibration (judge: ${STAR_JUDGE_MODEL})\n\n`)
  let agree = 0
  for (const c of STAR_CALIBRATION) {
    const v = await judgeStarBullets([c.bullet])
    const judged = v.counted === 1
    const ok = judged === c.counts
    if (ok) agree++
    const label = c.counts ? 'counts' : 'no'
    process.stdout.write(`${ok ? '✓' : '✗'} [label: ${label}, ${c.why}] ${c.bullet}\n`)
    if (!ok) process.stdout.write(`    judge: ${judged ? 'counts' : `no, ${v.misses[0]?.reason ?? ''}`}\n`)
  }
  process.stdout.write(`\nAgreement: ${agree}/${STAR_CALIBRATION.length}\n`)
  process.exit(agree === STAR_CALIBRATION.length ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`Calibration crashed: ${(err as Error).message}\n`)
  process.exit(2)
})
