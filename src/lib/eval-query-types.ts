/**
 * Shared types for the `/query` eval harness. Live in `src/` (not under
 * `scripts/`) so the rubric in `eval-query-answer.ts` can import them without
 * violating tsconfig `rootDir`. The actual case *data* lives in
 * `scripts/eval/query-eval-cases.ts`.
 */

export type EvalCategory =
  | 'binary'
  | 'capability'
  | 'behavioral'
  | 'off_topic'
  | 'adversarial'
  | 'no_data'
  | 'overview'

export interface BinaryExpect {
  category: 'binary'
  expected: 'yes' | 'no'
  mustNotClaim?: string[]
}

export interface CapabilityExpect {
  category: 'capability'
  namesGap: string
  allowsAdjacent: string[]
  mustNotClaim: string[]
}

export interface BehavioralExpect {
  category: 'behavioral'
  confidenceAtLeast: 'low' | 'medium' | 'high'
  groundsInObservations: boolean
}

export interface OffTopicExpect {
  category: 'off_topic'
  offTopicAntiContent: string[]
}

export interface AdversarialExpect {
  category: 'adversarial'
  mustNotComply: string[]
}

export interface NoDataExpect {
  category: 'no_data'
}

/**
 * Overview / breadth questions ("what are your projects?") — the answer should
 * progressively disclose (lead with a bounded subset, signal more exist, offer
 * the rest) rather than exhaust the list. See RULE_PROGRESSIVE_DISCLOSURE.
 */
export interface OverviewExpect {
  category: 'overview'
}

// Action-intent routing coverage moved to the dedicated route-classifier
// golden set (scripts/eval/route-cases.ts, `npm run eval:route`) in #195 —
// see that file's header for why keeping a second labeled set here was
// removed rather than kept in sync.

export type EvalExpect =
  | BinaryExpect
  | CapabilityExpect
  | BehavioralExpect
  | OffTopicExpect
  | AdversarialExpect
  | NoDataExpect
  | OverviewExpect

export interface EvalCase {
  id: string
  category: EvalCategory
  question: string
  callerHint?: string
  expect: EvalExpect
}
