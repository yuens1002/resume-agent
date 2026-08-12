# /review report — match quality-extraction (implementation)

**Branch:** `feat/match-quality-extraction`
**Generated:** 2026-08-12 — reviewed against the working tree, uncommitted (D1-D9 implemented)
**Iterations to reach verified:** 1

## Verdict

**Minor issue found and fixed during this review — otherwise clear.** All D1-D9 deliverables landed as planned, all 9 in-scope ACs independently verified PASS by a Phase 3 sub-agent and confirmed by my own re-checks, and the four implementation-time surprises (rubric regression, shared-infra bug, missed in-repo consumer, fixture over-optimism) all resolved soundly rather than papered over. One genuine docs-drift miss — `docs/workflow.md` had a second full worked example of the old fixed shape, including the exact stale "skills 50%, experience 30%, domain 20%" line, that neither D3 nor the original downstream-contract check touched — found here and fixed in this same pass. Ready for Phase 5 (Human Review).

**Final check before commit (2026-08-12, same day, later pass):** owner asked whether `google/gemma-4-26b-a4b-it` (the actual production `MATCH_MODEL`) specifically benefits from this redesign, distinct from the cross-model spike sample. Answer, grounded in already-collected evidence: both full 21-case `eval:match` runs were on that model specifically (not a blend) — `sd` moved from the reported `0.053` to `0.215`/`0.224` across two independent runs on the real production model, and D6's same-model repeatability dimension is that model's own reliability profile (anchors fully agree across 5 runs; the deliberately ambiguous case shows bounded, not zero, variance). Answering this surfaced that `scripts/eval/match-eval-cases.ts`'s own doc comments were stale — 18 of 21 cases still said "not yet spike-run," true of the informal 3-round spike script but no longer true of D5's formal `eval:match` runner, which validated all 21 live. Fixed: the file header's "Confidence note" and all 26 per-case annotations (25 via exact-string `replace_all`, 1 caught separately because its phrasing didn't match the literal string — re-verified live rather than guessed at). Final sweep after the fix: `tsc` clean, 557/559 `test:unit` pass (2 pre-existing skips), zero remaining `spike-run` or old-`scoring`-shape references anywhere in `src/` or the eval fixture. No new code paths touched — this pass was fixture/doc-comment accuracy only. Still ready for Phase 5 / commit.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|---|---|---|
| D1 | `src/lib/score-match.ts` (full rewrite) — extraction-first rubric, `qualityScore`, normalizer, retired `skillsScore` | ✓ shipped |
| D2 | `src/types.ts:185-222` — `MatchScoring`/`MatchRequiredQuality`/`MatchScoredQuality` | ✓ shipped |
| D3 | `src/routes/openapi.ts:106-142`, `README.md:382-401` | ✓ shipped, **but see docs-drift finding below — a second doc (`docs/workflow.md`) needed the same fix and wasn't caught by D3's own scope** |
| D4 | `scripts/eval/match-eval-cases.ts` (full rework) | ✓ shipped |
| D5 | `scripts/eval/run-match-eval.ts` (new) | ✓ shipped, live-validated (27/27, twice) |
| D6 | `tests/match-quality-consistency.test.ts` (new) | ✓ shipped, live-validated (7/7, twice) |
| D7 | `tests/score-match-bounds.test.ts` (full rewrite) | ✓ shipped, 11/11 pass |
| D8 | `package.json` — `eval:match`, `test:match-consistency` scripts | ✓ shipped (deviated soundly from the plan's literal wording — see AC-REG-3) |
| D9 | `CHANGELOG.md`, `package.json`/`package-lock.json` version → 0.4.107 | ✓ shipped |
| D10, D11 | — | correctly out of scope, cross-repo, sequenced after production deploy |

### Code changes not tied to any deliverable

- `src/lib/ai.ts` — `generateWithLengthRetry`/`LengthRetryResult` relocated from `src/routes/query.ts`, `retryCeiling` param added. Not a named deliverable, but directly required by D6 (the test that surfaced the bug) and by D1 (the caller that needed a working retry). Correctly scoped: `query.ts`'s own call site is unchanged (verified — still 2 args, defaults to the original `retryCeiling=2048`), so this is additive to a shared helper, not a behavior change to an existing production path.
- `src/routes/mcp.ts` — `score_match` tool's summary formatting rewritten. Not a named deliverable (the original plan's downstream-contract check missed this in-repo consumer entirely), but required — the code did not compile against the new `MatchScoring` type otherwise. Correctly scoped to formatting only.
- `docs/workflow.md` — fixed in this review pass (see below), not by D3's original implementation.

Both of the first two are legitimate "found during implementation" fixes, documented in the CHANGELOG's own entry rather than landing silently — not undisclosed scope creep.

## ACs ↔ Tests (Gate 3 spot-check, independent of the Phase 3 sub-agent's own pass)

| AC | Test file | Asserts invariant? | Notes |
|---|---|---|---|
| AC-TST-1 | `tests/score-match-bounds.test.ts` | ✓ | `assert.ok(score >= 0 && score <= 1, ...)` across parametrized overflow shapes — a real invariant, not a literal. The "reduces to #240's exact results" test is deliberately an equality check, but that's correct here: it's proving behavioral continuity at a known fixed point, not standing in for the bound check. |
| AC-TST-2 | `scripts/eval/run-match-eval.ts` via `match-eval-cases.ts` | ✓ | Expectations use `verdict`/`evidenceGrade` **arrays** (acceptable-set semantics) rather than single-value equality, and `mustBeExtracted: false` is a real escape hatch, not a silent pass-everything — confirmed by reading `checkExpectation()`'s logic in the runner: a `mustBeExtracted: false` quality that genuinely wasn't found returns `pass: true` with an explicit "not extracted (acceptable)" detail string, distinguishable in output from a lazy always-true. |
| AC-TST-3/4 | `tests/match-quality-consistency.test.ts` | ✓ | Independently re-read (not just trusting the Phase 3 sub-agent's file inspection): the ambiguous case's test (`scale-different-large-enterprise`) asserts only `rate >= 0 && rate <= 1` — a sanity bound — and separately `console.log`s the actual rate. This is honest: it cannot silently pass by asserting nothing meaningful, because a truly broken run (e.g. `scoreMatch` throwing) would still fail via the earlier `assert.ok(result, ...)` in `repeatedRuns()`. |

**On the two fixture loosenings flagged for special attention** (IC-status → `claimed` not `verified`; tech-lead mentorship → `missing` not `partial/matched`): read both `note` fields in `match-eval-cases.ts` directly. Both cite the rubric's own `evidence_grade` definition (`verified` = "backed by a dated project with `git_evidence`, or an unambiguous employment date range") to justify why `claimed` is the more defensible reading for an *inferred* IC status, and both explicitly say "not a model bug" with the reasoning stated, rather than silently loosening without explanation. This is principled — the note is falsifiable (someone could argue IC status *should* count as verified and take it up on those grounds) rather than "whatever the model said becomes correct by definition." Not a rubber-stamp.

## Docs drift

| Location | Status |
|---|---|
| `docs/workflow.md:86-117` | **Was stale — fixed in this review.** Full worked example showed the old `scoring.skills/experience/domain` shape verbatim, plus the literal "Scoring weights: skills 50%, experience 30%, domain 20%" line. Neither the original plan's D3 (scoped to `openapi.ts` + `README.md` only) nor the downstream-contract check touched this file. Now shows the new `required_qualities`/`scored_qualities` shape with a representative example and updated prose. |
| `README.md:382-401`, `openapi.ts:106-142` | Clean — no stale references found (grepped for old-shape terms, zero hits). |
| `docs/plans/match-score-bounds-review.md:63` | Contains a "checked and not stale" note about `docs/workflow.md`'s old weighting — but this is a dated historical record of PR #241's own review (2026-08-10, before this redesign), correctly describing that PR's state at the time. Not living documentation; no update needed, same call as the original planning-phase `/review`. |
| `docs/plans/match-quality-extraction.md`, `-review.md` | References to the old shape are all in historical/narrative context (documenting D11's still-pending future work in `resume-agent-web`, or the correction narrative from the planning-phase review) — correct as written, not drift. |

## Recommendations

1. **Done in this pass:** `docs/workflow.md` updated to the new response shape.
2. When D3-equivalent doc-update deliverables are scoped in future plans, explicitly grep the whole `docs/` tree for the pattern being replaced (not just the files named in the deliverable) — `docs/workflow.md` had the identical worked-example pattern as `README.md` and was missed by naming files up front rather than searching for the pattern. This is the same failure class as the planning-phase `/review`'s `resume-agent-web` miss (naming known consumers vs. searching for the actual pattern), recurring once more at the docs layer.

## Inputs for /retro

- **Route:** `/backend-architect` → `.claude/commands/backend-architect.md`
  **Draft principle:** *"When a deliverable updates documentation to remove a stale claim (a response shape, a weighting formula, a rubric description), grep the entire docs/ tree for the pattern being removed — not just the files the plan named up front. A worked example or claim can be duplicated across multiple docs (README + a separate workflow/integration guide) without either file referencing the other, so naming files from memory misses siblings a full-repo search would catch."*
  **Triggered by:** `docs/workflow.md`'s duplicate stale example, missed by both the original plan's D3 scope and the downstream-contract check — the second occurrence of this exact failure class in this feature (the first being `resume-agent-web`'s missed consumer at the planning stage).

- **Route:** `/backend-architect`
  **Draft principle:** *"When reusing a shared helper with a hardcoded internal constant (a retry ceiling, a cap, a threshold) at a new call site whose own parameters approach or exceed that constant, check whether the constant silently degenerates for the new caller before assuming the shared code 'just works' by inheritance. A helper correct for its original caller can be a no-op for a new one without erroring — it has to be caught by actually exercising the new path, not by code review of the helper in isolation."*
  **Triggered by:** `generateWithLengthRetry`'s `min(cap * 2, 2048)` silently no-opping for `/match`'s `2048`-token starting cap — caught only because D6's live test run surfaced a real `null` return from `gemini-3.6-flash`, not by reading the (individually correct) helper code.
