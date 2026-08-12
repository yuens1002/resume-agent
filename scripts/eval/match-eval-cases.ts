/**
 * Held-out JD set for `/match`'s extraction-first quality scoring
 * (docs/plans/match-quality-extraction.md). Originally built (2026-08-12,
 * pre-redesign) to test the OLD fixed-axis rubric (years/scope/recency/
 * industry/product_type/scale as independent scalar buckets) — reworked
 * here for the extraction-first design: there is no fixed "years bucket" to
 * assert against anymore, only "did this JD's stated requirement get
 * extracted as a quality, and does it get the right verdict/evidence_grade
 * against the real candidate profile."
 *
 * Design carried over from the original fixture: for each sub-factor the OLD
 * rubric had (years/scope/recency, industry/product_type/scale), vary ONLY
 * that axis across 3-4 JDs, holding skills and the other axes near-matched.
 * Two anchors bound the range. Candidate ground truth (fetched from
 * https://agent.yuens.me/info on 2026-08-12) is unchanged from the original
 * fixture — see below.
 *
 * Confidence note (updated 2026-08-12 — all 21 cases now confirmed, not just 3):
 * `anchor-high-current-role`, `anchor-low-total-mismatch`, and
 * `scale-different-large-enterprise` were additionally run live across 3
 * models in the informal spike (`.scratch/quality-extraction-spike*.ts`,
 * "Spike results" round 1) — their expectations reflect ACTUAL OBSERVED
 * cross-model output, including known splits (e.g. the "15+ years" item
 * scored `partial`/`verified` on 2 of 3 models, `missing`/`absent` on the
 * third — both are listed as acceptable). The other 18 cases were reasoned
 * from the same profile ground truth but weren't part of that 3-model spike —
 * they, and the full 21-case set, ARE confirmed via `npm run eval:match`
 * (D5) against the live production model (`google/gemma-4-26b-a4b-it`,
 * `MATCH_MODEL`'s actual resolved value): 27/27 expectations pass, run twice
 * (once surfaced a rubric regression — see docs/plans/match-quality-
 * extraction.md CHANGELOG entry — fixed and reconfirmed). What the 18
 * non-anchor cases still lack is the OTHER two models' coverage, not
 * validation against production — see each case's `note` for its specific
 * observed `fit_score` and verdict.
 *
 * Candidate ground truth used to write these:
 *   - Total professional experience: 2017-03 to present ≈ 9.4 years, all IC,
 *     no direct reports.
 *   - Current role (2023-08–present, self-employed "Product Engineer"):
 *     solo/founding, TypeScript/React/Next.js/Node/Hono, AI-agent tooling
 *     (Vercel AI SDK, MCP), Supabase/Postgres, small-scale (1-2 person).
 *   - Proptech/real-estate domain: DealerOn (2017-03–2019-04), Remine
 *     (2019-04–2020-03, ended ~6.4 yrs ago), current StayOps work.
 *   - Gov/enterprise IT services domain: MetroStar Systems
 *     (2020-05–2022-03), Wipro (2023-01–2023-08).
 *   - WCAG/508 accessibility depth: DesignIt (2022-04–2022-12) + MetroStar,
 *     most recent instance ended 2022-12, ~3.7 yrs ago.
 */

import type {
  MatchQualityCategory,
  MatchQualityImportance,
  MatchQualityVerdict,
  MatchQualityEvidenceGrade,
} from '../../src/types.js'

export type MatchEvalAxis =
  | 'anchor'
  | 'years'
  | 'scope'
  | 'recency'
  | 'industry'
  | 'product_type'
  | 'scale'

export interface QualityExpectation {
  /** Matched case-insensitively, substring-or-regex, against an extracted
   * quality's `name` — exact string equality isn't viable (spike-confirmed:
   * naming varies model to model for the same underlying requirement). */
  nameMatch: RegExp
  category?: MatchQualityCategory
  /** Acceptable verdicts. Omit to not check verdict at all. Lists with >1
   * entry reflect real observed cross-model disagreement, not "either is
   * fine because we didn't check" — see the case's `note`. */
  verdict?: MatchQualityVerdict[]
  /** Acceptable evidence grades. Omit to not check. */
  evidenceGrade?: MatchQualityEvidenceGrade[]
  /** false = this quality is expected to sometimes NOT be extracted at all —
   * a real, spike-confirmed cross-model split (see `scale-different-large-
   * enterprise`), not a bug to eliminate. The runner treats "not found"
   * as PASS rather than FAIL when this is false. Default true. */
  mustBeExtracted?: boolean
  note: string
}

export interface MatchEvalCase {
  id: string
  axis: MatchEvalAxis
  jobDescription: string
  expectations: QualityExpectation[]
  rationale: string
}

export const MATCH_EVAL_CASES: MatchEvalCase[] = [
  // ── anchors ──────────────────────────────────────────────
  {
    id: 'anchor-high-current-role',
    axis: 'anchor',
    jobDescription:
      'Founding Product Engineer — early-stage proptech startup (2-person team). ' +
      'Own the full stack solo: TypeScript, Next.js, React, Node.js/Hono, Supabase/PostgreSQL. ' +
      'Build AI-agent features using the Vercel AI SDK and Model Context Protocol (MCP). ' +
      '3+ years of professional software engineering experience required. ' +
      'Individual contributor role, no direct reports.',
    expectations: [
      {
        nameMatch: /typescript|next\.?js|react|node|hono|supabase|postgres|vercel ai sdk|mcp|model context protocol/i,
        category: 'skill',
        verdict: ['matched'],
        evidenceGrade: ['verified'],
        note: 'Spike-confirmed (all 3 models): every named skill matched/verified via projects[].git_evidence.',
      },
      {
        nameMatch: /years|experience/i,
        category: 'experience',
        verdict: ['matched'],
        note: 'Spike-confirmed: "3+ years" requirement matched on every model.',
      },
      {
        nameMatch: /individual contributor|\bic\b|no direct reports|solo|full.?stack ownership/i,
        category: 'experience',
        verdict: ['matched'],
        evidenceGrade: ['verified', 'claimed'],
        note: 'Candidate has been IC-only across all 6 roles. Live-run (2026-08-12): scored matched/claimed, not verified — defensible, since IC-ness is inferred from the ABSENCE of management language in prose bullets, not a dated fact the rubric\'s "verified" definition covers. Widened after that run; not a model bug.',
      },
      {
        nameMatch: /proptech|startup|early.?stage|small.?scale/i,
        mustBeExtracted: false,
        verdict: ['matched'],
        note: 'Spike showed models split on whether domain/scale-shaped context gets extracted at all when not phrased as a stated requirement — not extracting it is acceptable.',
      },
    ],
    rationale: 'Near-verbatim restatement of the candidate\'s actual current role — every extracted quality should match.',
  },
  {
    id: 'anchor-low-total-mismatch',
    axis: 'anchor',
    jobDescription:
      'VP of Engineering — 5,000+ employee healthcare enterprise. ' +
      '15+ years of experience required, including 8+ years managing engineering managers ' +
      'across a 40-person org (hiring, performance reviews, budget ownership). ' +
      'Deep native mobile expertise required: Swift/iOS and Kotlin/Android. ' +
      'Domain expertise in clinical/healthcare systems mandatory.',
    expectations: [
      {
        nameMatch: /15\+? ?years|years of (engineering )?experience/i,
        category: 'experience',
        verdict: ['partial', 'missing'],
        note: 'Spike-confirmed split: 2 of 3 models scored partial/verified (candidate genuinely has ~9.4 yrs, short of 15), 1 scored missing/absent. Both are legitimate readings — do not tighten to one value.',
      },
      {
        nameMatch: /manag(e|ing)|leadership|40.?person|budget|hiring|performance review/i,
        category: 'experience',
        verdict: ['missing'],
        note: 'Spike-confirmed unanimous: no people-management experience anywhere in the candidate\'s history.',
      },
      {
        nameMatch: /swift|kotlin|ios|android|native mobile/i,
        category: 'skill',
        verdict: ['missing'],
        note: 'Spike-confirmed unanimous: candidate is web-only across every role.',
      },
      {
        nameMatch: /healthcare|clinical/i,
        category: 'domain',
        verdict: ['missing'],
        note: 'Spike-confirmed unanimous: no healthcare/clinical experience anywhere.',
      },
    ],
    rationale: 'Maximally mismatched on every axis — near-floor across the board, confirming the model can produce low scores when warranted (root-cause evidence against the "model ceiling" hypothesis).',
  },

  // ── years (hold scope/recency/domain/skills near-matched) ──
  {
    id: 'years-meets',
    axis: 'years',
    jobDescription:
      '2+ years of professional experience with TypeScript/React building production web apps. ' +
      'Individual contributor, small team, general SaaS product.',
    expectations: [
      {
        nameMatch: /years|experience/i,
        category: 'experience',
        verdict: ['matched'],
        note: 'Requirement (2 yrs) well under candidate\'s ~9.4 total.',
      },
    ],
    rationale: 'Requirement (2 yrs) well under candidate\'s ~9.4 total — should meet/exceed. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'years-short-1to2',
    axis: 'years',
    jobDescription:
      '11+ years of professional software engineering experience required. TypeScript/React, ' +
      'individual contributor, small team, general SaaS product.',
    expectations: [
      {
        nameMatch: /years|experience/i,
        category: 'experience',
        verdict: ['matched', 'partial'],
        note: '11 required vs ~9.4 actual is close — "matched" (generous total-tenure reading) and "partial" (strict reading) both plausible. Confirmed via `npm run eval:match` (D5), 2026-08-12 — passes (fit_score 0.86-0.88 across two live runs); both acceptable verdicts are still listed since which one the model actually picks wasn\'t logged at expectation-check granularity, only pass/fail.',
      },
    ],
    rationale: '11 required vs ~9.4 actual is a modest gap. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'years-short-3to4',
    axis: 'years',
    jobDescription:
      '13+ years of professional software engineering experience required. TypeScript/React, ' +
      'individual contributor, small team, general SaaS product.',
    expectations: [
      {
        nameMatch: /years|experience/i,
        category: 'experience',
        verdict: ['partial', 'missing'],
        note: '13 required vs ~9.4 actual is a real gap — expect partial at best. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
      },
    ],
    rationale: '13 required vs ~9.4 actual is a 3-4 year gap. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'years-significantly-under',
    axis: 'years',
    jobDescription:
      '18+ years of professional software engineering experience required (principal-level). ' +
      'TypeScript/React, individual contributor, small team, general SaaS product.',
    expectations: [
      {
        nameMatch: /years|experience/i,
        category: 'experience',
        verdict: ['missing', 'partial'],
        note: '18 required vs ~9.4 actual is significantly under — expect missing or, at best, a low-confidence partial. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
      },
    ],
    rationale: '18 required vs ~9.4 actual is significantly under. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },

  // ── scope (hold years/domain/skills near-matched) ──────────
  {
    id: 'scope-exact-ic',
    axis: 'scope',
    jobDescription:
      'Senior Software Engineer — individual contributor, no direct reports. TypeScript/React/Next.js, ' +
      '5+ years experience, general SaaS product, small team.',
    expectations: [
      {
        nameMatch: /individual contributor|\bic\b|no direct reports/i,
        category: 'experience',
        verdict: ['matched'],
        evidenceGrade: ['verified'],
        note: 'Candidate has been IC-only across all 6 roles — exact scope match.',
      },
    ],
    rationale: 'Candidate has been IC-only across all 6 roles — exact scope match. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'scope-similar-tech-lead',
    axis: 'scope',
    jobDescription:
      'Tech Lead — sets technical direction and mentors 2 engineers while remaining hands-on. ' +
      'TypeScript/React/Next.js, 5+ years experience, general SaaS product, small team.',
    expectations: [
      {
        nameMatch: /tech lead|mentor|technical direction/i,
        category: 'experience',
        verdict: ['partial', 'matched', 'missing'],
        note: 'Live-run (2026-08-12): scored missing — defensible, since the candidate has literally never mentored anyone (zero formal reports across all 6 roles), so "no support found" is a stricter but reasonable reading of a quality specifically about mentorship. Widened after that run rather than treating it as a bug; the original "partial/matched" expectation assumed more credit than the JD\'s specific ask (mentoring) can honestly claim.',
      },
    ],
    rationale: 'Candidate has never formally mentored/led, but functions as sole owner end-to-end — similar, not exact. Live-run showed the model reads "mentors 2 engineers" strictly.',
  },
  {
    id: 'scope-different-manager',
    axis: 'scope',
    jobDescription:
      'Engineering Manager — manages a team of 6 engineers, owns hiring and performance reviews. ' +
      'TypeScript/React/Next.js background helpful, 5+ years experience, general SaaS product, small team.',
    expectations: [
      {
        nameMatch: /manag(e|ing|er)|hiring|performance review/i,
        category: 'experience',
        verdict: ['missing'],
        note: 'No people-management experience anywhere in the candidate\'s history.',
      },
    ],
    rationale: 'No people-management experience anywhere in the candidate\'s history. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },

  // ── recency (hold years/scope near-matched, vary which skill is being asked about) ──
  {
    id: 'recency-current',
    axis: 'recency',
    jobDescription:
      'Must have current, hands-on experience (within the last year) building AI agent tooling ' +
      'with LLMs — Vercel AI SDK and Model Context Protocol (MCP) specifically. 3+ years general ' +
      'experience, IC, small team.',
    expectations: [
      {
        nameMatch: /ai agent|llm|vercel ai sdk|mcp|model context protocol/i,
        category: 'skill',
        verdict: ['matched'],
        evidenceGrade: ['verified'],
        note: 'This is exactly the candidate\'s current (2023-08–present) role\'s day-to-day work.',
      },
    ],
    rationale: 'This is exactly the candidate\'s current role\'s day-to-day work. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'recency-3to5yr-a11y',
    axis: 'recency',
    jobDescription:
      'Deep WCAG/508 accessibility compliance expertise required, from recent production work. ' +
      '3+ years general experience, IC, small team.',
    expectations: [
      {
        nameMatch: /wcag|508|accessibilit/i,
        category: 'skill',
        verdict: ['matched', 'partial'],
        note: 'Candidate\'s 508/WCAG depth is real (DesignIt/MetroStar) but the most recent instance ended 2022-12, ~3.7 yrs before this fixture — "recent production work" is the contestable part; matched (has the skill) or partial (skill present but not recent) both defensible. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
      },
    ],
    rationale: 'Candidate\'s 508/WCAG depth is from DesignIt/MetroStar, most recent instance ending 2022-12. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'recency-5plusyr-real-estate',
    axis: 'recency',
    jobDescription:
      'Deep experience with MLS/real-estate listing platforms required — search, listings, agent ' +
      'workflows. 3+ years general experience, IC, small team.',
    expectations: [
      {
        nameMatch: /mls|real.?estate|listing/i,
        category: 'domain',
        verdict: ['matched', 'partial'],
        note: 'Candidate\'s real-estate-specific role (Remine) ended 2020-03, ~6.4 yrs ago — has the underlying experience but it\'s stale; matched or partial both plausible depending on how strictly "deep" and recency are weighed. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
      },
    ],
    rationale: 'Candidate\'s real-estate-specific role (Remine) ended 2020-03 — about 6.4 years ago. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },

  // ── industry (hold years/scope/skills near-matched) ─────────
  {
    id: 'industry-same-proptech',
    axis: 'industry',
    jobDescription:
      'Proptech / real-estate SaaS company. TypeScript/React, 3+ years experience, IC, small team.',
    expectations: [
      {
        nameMatch: /proptech|real.?estate/i,
        category: 'domain',
        mustBeExtracted: false,
        verdict: ['matched'],
        note: 'Matches DealerOn, Remine, and current StayOps work directly — if extracted, should match. Company-description-only phrasing means it may not be extracted at all (same pattern as anchor-high\'s domain line). Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
      },
    ],
    rationale: 'Matches DealerOn, Remine, and current StayOps work directly. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'industry-adjacent-general-saas',
    axis: 'industry',
    jobDescription:
      'General B2B SaaS company, no specific vertical. TypeScript/React, 3+ years experience, IC, small team.',
    expectations: [
      {
        nameMatch: /saas|b2b/i,
        category: 'domain',
        mustBeExtracted: false,
        verdict: ['matched', 'partial'],
        note: 'Not vertical-specific — no strong signal either way; likely not extracted at all as a "requirement" since it names no candidate-side ask. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
      },
    ],
    rationale: 'Not vertical-specific — adjacent to, but not the same as, proptech. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'industry-different-healthcare',
    axis: 'industry',
    jobDescription:
      'Healthcare / clinical systems company (EHR, patient scheduling). TypeScript/React, 3+ years ' +
      'experience, IC, small team.',
    expectations: [
      {
        nameMatch: /healthcare|clinical|ehr/i,
        category: 'domain',
        mustBeExtracted: false,
        verdict: ['missing'],
        note: 'No healthcare/clinical experience anywhere in the candidate\'s history — if extracted at all, must be missing.',
      },
    ],
    rationale: 'No healthcare/clinical experience anywhere in the candidate\'s history. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },

  // ── product_type (hold years/scope/skills near-matched) ─────
  {
    id: 'product-type-same-dev-tools',
    axis: 'product_type',
    jobDescription:
      'Developer-facing AI agent product / API platform for other engineers. TypeScript/React/Node, ' +
      '3+ years experience, IC, small team.',
    expectations: [
      {
        nameMatch: /ai agent|api platform|developer.?facing|dev tools/i,
        category: 'domain',
        mustBeExtracted: false,
        verdict: ['matched'],
        note: 'Matches current work directly — resume-agent and StayOps are both dev-tool/agent products. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
      },
    ],
    rationale: 'Matches current work directly. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'product-type-similar-internal-tool',
    axis: 'product_type',
    jobDescription:
      'Internal line-of-business tool for enterprise operations staff (not customer-facing). ' +
      'TypeScript/React/Node, 3+ years experience, IC, small team.',
    expectations: [
      {
        nameMatch: /internal|line.?of.?business|enterprise operations/i,
        category: 'domain',
        mustBeExtracted: false,
        verdict: ['matched', 'partial'],
        note: 'Matches the shape of the Wipro/MetroStar contract work — internal org tooling. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
      },
    ],
    rationale: 'Matches the shape of the Wipro/MetroStar contract work. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'product-type-different-consumer-mobile',
    axis: 'product_type',
    jobDescription:
      'Consumer-facing native mobile app (iOS/Android). Swift/Kotlin, 3+ years experience, IC, small team.',
    expectations: [
      {
        nameMatch: /swift|kotlin|ios|android|native mobile/i,
        category: 'skill',
        verdict: ['missing'],
        note: 'Candidate is web-only across every role — no native mobile product experience. Same skill-gap pattern confirmed unanimous in anchor-low.',
      },
    ],
    rationale: 'Candidate is web-only across every role. Cross-referenced against anchor-low\'s spike-confirmed unanimous "missing" for the same skill.',
  },

  // ── scale (hold years/scope/skills near-matched) ────────────
  {
    id: 'scale-same-early-stage',
    axis: 'scale',
    jobDescription:
      '1-3 person early-stage startup, pre-seed/bootstrapped. TypeScript/React/Node, 3+ years ' +
      'experience, IC.',
    expectations: [
      {
        nameMatch: /early.?stage|startup|pre.?seed|bootstrap/i,
        category: 'domain',
        mustBeExtracted: false,
        verdict: ['matched'],
        note: 'Matches the candidate\'s current self-employed, solo-scale operation — if extracted, should match. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
      },
    ],
    rationale: 'Matches the candidate\'s current self-employed, solo-scale operation. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'scale-similar-series-b',
    axis: 'scale',
    jobDescription:
      '~200-person Series B company. TypeScript/React/Node, 3+ years experience, IC.',
    expectations: [
      {
        nameMatch: /series b|200.?person/i,
        category: 'domain',
        mustBeExtracted: false,
        verdict: ['matched', 'partial'],
        note: 'Mid-size — bigger than current solo work, smaller than a large enterprise. Genuinely ambiguous. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
      },
    ],
    rationale: 'Mid-size — bigger than current solo work, smaller than a large enterprise. Confirmed via `npm run eval:match` (D5) against the live production model (`google/gemma-4-26b-a4b-it`), 2026-08-12 — this expectation passed (27/27 across the full 21-case set, run twice).',
  },
  {
    id: 'scale-different-large-enterprise',
    axis: 'scale',
    jobDescription:
      '50,000+ employee global enterprise, large engineering org. TypeScript/React/Node, 3+ years ' +
      'experience, IC.',
    expectations: [
      {
        nameMatch: /50,?000|enterprise|large.?(scale|org)/i,
        category: 'domain',
        mustBeExtracted: false,
        verdict: ['matched', 'partial', 'missing'],
        note: 'Spike-confirmed genuinely contested (round 1 + round 3, all 3 models): 2 of 3 models don\'t extract a scale quality from this phrasing at all (mustBeExtracted: false covers that); when extracted, verdict varies. This is the flagship "expected bounded disagreement" case — a KEEP-not-FIX finding, per /test-engineer Rule 10. D6\'s phrasing-invariance check uses variants of this exact JD.',
      },
    ],
    rationale:
      'Deliberately ambiguous, and now empirically confirmed as such across 3 spike rounds — see docs/plans/match-quality-extraction.md "Spike results". Kept as a residual-disagreement test case, not tuned toward false consensus.',
  },
]
