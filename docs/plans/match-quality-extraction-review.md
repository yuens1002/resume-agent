# /review report — match quality-extraction (planning phase)

**Branch:** `feat/match-quality-extraction` (not yet created — plan-only)
**Generated:** 2026-08-12 — reviewed against `docs/plans/match-quality-extraction.md`, no implementation code exists yet
**Iterations to reach verified:** 1

## Verdict

**Major issues — root-cause diagnosis holds up under independent re-verification, and the three confirmed design decisions are faithfully carried through the deliverables without softening, but the plan is missing a real downstream consumer and a public documentation surface that this exact redesign breaks.** Both must be added before this plan is ready to hand off to implementation. One internal-consistency gap (`skillsScore`'s fate) and one test-methodology gap (D6's consistency check) are also flagged — smaller, but should be resolved before their respective deliverables are implemented.

## Structural exception — planning-phase review, not post-implementation

This ran before Phase 2 (Implement), by explicit request — the plan itself says "do not start implementation." Steps 1 and 2 of the standard `/review` protocol (deliverables↔code, ACs↔tests) therefore have nothing to diff against; every deliverable is correctly "not yet implemented," which is not a finding. What follows is (a) independent re-verification of the plan's factual claims against live repo state, not trust in the conversation that produced them, and (b) an internal-consistency check between the plan's confirmed decisions and its own deliverables/ACs.

Owning roles per the plan's own Role column: `/backend-architect`, `/test-engineer`. Role context loaded from `~/.claude/commands/backend-architect.md` and `~/.claude/commands/test-engineer.md` (no project-local override exists in this repo).

## Root-cause diagnosis — re-verified against live state

| Claim in the plan | Verification | Result |
|---|---|---|
| `skills` does JD-driven extraction, `experience`/`domain` don't | `src/lib/score-match.ts:100` (`required_skills_extracted`), `:75-93` (fixed `SCORING_RUBRIC` for experience/domain) | ✓ confirmed |
| PR #241's sd=0.053/p50=1.00 figures | `gh pr view 241` body, quoted directly | ✓ confirmed, correctly attributed |
| Profile has no structured years field | Live `GET https://agent.yuens.me/info` — no such key; only prose "6+ years" in `summary`. `supabase/migrations/*.sql` — no years column ever existed | ✓ confirmed |
| `git_evidence` exists on `projects`, not `employment` | Live `/info` fetch — `projects[].git_evidence` present (commit_count, dates, signature); `employment[]` has only title/company/bullets/dates | ✓ confirmed |
| `job-hunt-agent` only consumes `fit_score`/`verdict`/`matched`/`gaps`/`recommended_action`; `scoring` is opaque there | Grepped `job-hunt-agent/src/*.ts`; `src/match.ts:8-15` types `scoring: Record<string, unknown>` | ✓ confirmed **for that repo** — see MAJOR finding below, the check stopped one repo short |

The diagnosis is sound. No claim in the plan's Context section was found to be fabricated or misremembered from the conversation that produced it.

## MAJOR — `resume-agent-web` is an undiscovered consumer that this redesign directly breaks

The plan's "Downstream contract check" verified only `job-hunt-agent` and concluded `scoring`'s internal shape was free to change. It is not — `resume-agent-web` (`github.com/yuens1002/resume-agent-web`, this repo's own README-listed frontend) destructures it directly:

- `src/lib/types.ts` — a hand-maintained local mirror of `MatchScoring`/`MatchResponse`.
- `src/components/MatchResume.tsx`:
  ```tsx
  <ScoreBar label="Skills" weight="50%" score={result.scoring.skills.score} />
  <ScoreBar label="Experience" weight="30%" score={result.scoring.experience.score} />
  ```
  (and the `domain`/20% equivalent) — hardcoded weight labels matching the exact fixed split this plan removes.
- `prototype/DESIGN-HANDOFF.md` documents the contract explicitly: `scoring:{ skills, experience, domain }`, "bars from `scoring.*.score`".

Under D1/D2's confirmed "fully dynamic per-JD weighted quality list," `scoring.experience`/`scoring.domain` as fixed objects with `.score` cease to exist — `result.scoring.experience.score` becomes `undefined`. `MatchResume.tsx` breaks at runtime the moment the new API ships, independent of whether it also throws; even a defensive `?? 0` would render "30%"/"20%" labels that are no longer true under the aggregation this plan chose.

This is the exact scenario the PM persona's own retro-sourced principle already names: *"A response-contract change that a downstream repo depends on ships the downstream-needed field in the SAME PR... not a later cleanup."* The plan doesn't violate this by a considered tradeoff — it violates it because the consumer wasn't found.

**This blocks hand-off the same way a missing deliverable normally would** — shipping D1/D2 without it breaks a real, live user-facing surface.

## MAJOR — `README.md`'s public methodology section documents the exact rubric being replaced

`README.md:382-406`, "## Agentic job match methodology":

> **2. Score against profile by category:** Technical skills / Experience depth: years, scope, recency / Domain overlap: industry, product type, scale / Role alignment
> **3. Produce a fit score weighted as:** Required skills coverage: 50% / Experience alignment: 30% / Domain overlap: 20%

This is the single most direct public statement of the fixed rubric and weights the plan removes, and no deliverable touches it — D3 only covers `src/routes/openapi.ts`. Once D1 ships, both the "score by category" list and the 50/30/20 weighting are false: categories are no longer fixed, and under the confirmed "fully dynamic" decision there is no longer a static weight split to state.

This is the same failure mode as an already-recorded retro principle in both the PM skill and `/backend-architect`'s own skill file ("Docs-only deliverables need AC coverage at authoring time") — worth citing directly as a second, independent occurrence rather than a new lesson.

## MINOR — `skillsScore`'s fate is ambiguous between D1 and D7

D1: "replace fixed `SCORING_RUBRIC` + `RawScores` + `scoreMatch` aggregation" — under the plan's own "Proposed shape," `skills` becomes just one `category: 'skill'` inside the unified quality list, implying `skillsScore` (the #240/#241 function) is absorbed or retired.

D7: extend `tests/score-match-bounds.test.ts` to cover the new aggregation's bound, "**alongside (not replacing)** the existing `skillsScore` coverage."

"Alongside, not replacing" is only coherent if `skillsScore` survives as a real function the new aggregator still calls per skill-category quality. Nothing in D1 or the proposed shape says whether that's the design or whether it's fully retired. As written, D1 and D7 could each be satisfied by implementations that contradict each other.

**Recommendation:** `/backend-architect` resolves explicitly at D1 time — either (a) keep `skillsScore` as an internal per-quality credit helper the unified aggregator calls (D7's wording is then correct), or (b) retire it (D7 should say "migrate," and the #240 tests need deletion or explicit re-justification, not "alongside").

## MINOR — D6/AC-TST-3 doesn't yet distinguish "Reproduced" from "Argued" (test-engineer Rule 10)

`/test-engineer`'s own Rule 10 applies directly: N=5 repeats on `anchor-high`/`anchor-low` — both deliberately extreme, unambiguous cases — will likely agree trivially every run. That shows the model is consistent on easy cases, not on the ones that actually matter: the mid-spread, evidence-ambiguous cases (the plan's own Open Item 3 already flags `scale-different-large-enterprise` as one). A green D6 run on anchors alone risks being "Argued" dressed as "Reproduced" — exactly the trap Rule 10 exists to catch.

**Recommendation:** D6/AC-TST-3 should include at least one deliberately ambiguous case in the N-repeat set, and its Pass cell should state which case(s) are expected to show bounded disagreement (Reproduced: disagreement exists and is within tolerance) versus which are expected to be stable (Argued: unambiguous cases agreeing is a weaker but still useful signal) — not one undifferentiated pass bar.

## Gate 1/2 — re-verified independently

All of D1-D10 have ≥1 AC row citing their ID; no `Role` column entry is `TBD`. (If D11 is added per the resume-agent-web finding, it needs its own AC row before Gate 1 passes again — not yet satisfied.)

## Docs drift scan

| Location | Status |
|---|---|
| `README.md:382-406` (methodology) | ⚠ stale once D1 ships — see MAJOR finding above, not currently covered by any deliverable |
| `resume-agent-web/src/components/MatchResume.tsx`, `src/lib/types.ts`, `prototype/DESIGN-HANDOFF.md` | ⚠ breaking, not currently covered — see MAJOR finding above |
| `docs/eval-baselines.md` | `/query`-only, unaffected, no action |
| `docs/plans/match-score-bounds-review.md` | Dated historical record of #241, correctly describes that PR's state — not living documentation, no update needed |
| `CHANGELOG.md` | D9 already covers this; style matches existing entries (verified against #241's own CHANGELOG entry) |

## Recommendations

1. Add **D11** — `resume-agent-web`: update `MatchResume.tsx` + local `MatchScoring`/`MatchResponse` types to render a variable-length dynamic quality list instead of three fixed weighted bars; update `prototype/DESIGN-HANDOFF.md`. Add its AC row (`AC-XR-2`), sequenced the same way as D10 (after D1-D9 ship). Confirm owning role — likely `/frontend-dev` even though it's a separate repo, per the PM skill's own rule that ownership follows the deliverable's center of gravity, not which repo it's in.
2. Extend D3 (or add an `AC-COV` row) to also rewrite `README.md:382-406`'s methodology section, not just `openapi.ts`.
3. Resolve `skillsScore`'s fate explicitly before D1 implementation starts; correct D7's "alongside, not replacing" wording to match whichever is chosen.
4. Strengthen D6/AC-TST-3 to include a deliberately ambiguous case and state explicitly which cases are expected to show bounded disagreement vs. stability, invoking `/test-engineer` Rule 10 by name.

## Inputs for /retro

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md` (or the PM skill, if downstream-contract checks are considered a planning-phase responsibility)
  **Draft principle:** *"When a redesign changes a public API's internal response shape, the downstream-consumer check must cover every repo/surface this project's own README lists as a consumer of that endpoint — not just the one most recently discussed in conversation. Grep each one for direct destructuring of the changing field before concluding a field is 'safe to redesign freely because it's untyped downstream' — untyped in one consumer does not mean unconsumed everywhere."*
  **Triggered by:** `resume-agent-web`'s `MatchResume.tsx` reading `scoring.experience.score`/`scoring.domain.score` directly, missed because the contract check stopped at `job-hunt-agent`.

- **Route:** `/backend-architect` (second, independent occurrence of an already-recorded principle)
  **Draft principle:** *"A rubric/scoring redesign that changes weighting or category structure is a docs-only deliverable gap risk on the README's narrative methodology section, not just the OpenAPI schema — the human-readable explanation is a distinct artifact from the machine-readable one and goes stale independently."*
  **Triggered by:** `README.md:382-406` documenting the exact fixed 50/30/20 weighting this plan removes, uncovered by any deliverable.

- **Route:** `/test-engineer` → `.claude/commands/test-engineer.md` (Rule 10 already exists; this is a note that it should be invoked explicitly at AC-authoring time, not just available)
  **Draft addition to Rule 10:** *"When a consistency/stability AC is authored (N repeated runs expected to agree), name at least one deliberately ambiguous input in the sample set alongside any anchor/extreme cases, and state in the Pass cell which inputs are expected to show bounded disagreement versus which are expected to be stable. An all-anchor sample can pass trivially without exercising the judgment the AC exists to check."*
  **Triggered by:** D6/AC-TST-3 in `docs/plans/match-quality-extraction.md`, currently scoped to anchor-high/anchor-low plus unspecified "mid-spread" cases with one undifferentiated tolerance.
