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
  | 'action_intent'

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

/**
 * Action-intent routing (#174): does the question want a narrated answer, or
 * does it want to open the job-match/résumé-tailoring flow? `shouldOpenTool`
 * is the ground-truth label a human assigned to the question. Negative cases
 * (topically adjacent but should NOT open the tool) are as important as
 * positive ones — that boundary is exactly what a client-side regex can't
 * hold, and is the reason #174 proposes real tool-calling instead.
 *
 * NOTE: `QueryResponse` does not carry an action-intent signal yet (see
 * `ruleActionIntent` in `eval-query-answer.ts`). Every case in this category
 * fails until #174 ships the real field — that failure is the point: it
 * makes #174 a falsifiable target instead of an abstract proposal.
 */
export interface ActionIntentExpect {
  category: 'action_intent'
  shouldOpenTool: boolean
}

export type EvalExpect =
  | BinaryExpect
  | CapabilityExpect
  | BehavioralExpect
  | OffTopicExpect
  | AdversarialExpect
  | NoDataExpect
  | OverviewExpect
  | ActionIntentExpect

export interface EvalCase {
  id: string
  category: EvalCategory
  question: string
  callerHint?: string
  expect: EvalExpect
}
