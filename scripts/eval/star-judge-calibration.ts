/**
 * Labeled calibration set for the STAR/XYZ judge (#298).
 *
 * Each label is the owner's call on whether the bullet states a real result.
 * `npm run eval:star-judge` runs the judge over these and reports agreement,
 * so a prompt or judge-model change can be checked before it's trusted.
 *
 * None of these appear as examples in the judge prompt itself; otherwise the
 * agreement figure would only measure memorisation.
 */

export interface StarCalibrationCase {
  bullet: string
  counts: boolean
  /** Why the label is what it is. */
  why: string
}

export const STAR_CALIBRATION: StarCalibrationCase[] = [
  // Results that count
  { bullet: 'Cut p95 latency from 11.3s to 320ms by adding two-layer response caching', counts: true, why: 'numeric before→after' },
  { bullet: 'Raised unit test coverage from 50% to over 80% across the component library using Jest', counts: true, why: 'numeric before→after' },
  { bullet: 'Led migration of 40 services to Kubernetes', counts: true, why: 'scale of what was delivered' },
  { bullet: 'Integrated Microsoft Active Directory to make all airport personnel searchable, replacing phone directories', counts: true, why: 'replaced a prior process' },
  { bullet: 'Built a reporting app with Next.js and React, used by all airport personnel and management layers', counts: true, why: 'adoption by a named group' },
  { bullet: 'Kept development velocity on the agreed iteration cadence across a 100+ person SAFe Agile program by sizing work in planning and surfacing spec-implementation gaps in standups', counts: true, why: 'held an agreed schedule at stated scale' },
  { bullet: 'Built a query interface so power users could search their inventory database without learning a query language', counts: true, why: 'capability delivered to a named user' },
  { bullet: 'Reduced open npm security vulnerabilities to zero through automated and manual dependency updates', counts: true, why: 'end state reached' },

  // Not results
  { bullet: 'Adopted Vue to boost user retention', counts: false, why: 'intention only' },
  { bullet: 'Released the public API to increase partner engagement', counts: false, why: 'intention only' },
  { bullet: 'Built a dashboard without tests', counts: false, why: 'nothing achieved' },
  { bullet: 'Reworked the service layer, making it much better', counts: false, why: 'vague claim' },
  { bullet: 'Automated accessibility and code-quality testing using Jest, Playwright and Cucumber', counts: false, why: 'duty and tools only' },
  { bullet: 'Built global UI components (modals, drawers) for a shared library with the UX team', counts: false, why: 'duty only' },
  { bullet: 'Reduced hosting costs substantially by consolidating clusters', counts: false, why: 'vague magnitude' },
  { bullet: 'Participated in daily standups and sprint planning', counts: false, why: 'duty only' },
]
