# /review report — match score bounds (#240)

**Branch:** `fix/match-skills-score-bounds` (PR #241)
**Generated:** 2026-08-10 — reviewed pre-commit, against the working tree that became commit `baaba06`
**Iterations to reach verified:** 1

## Verdict

**Minor issues — all resolved in PR #241 before merge.** The code change is correct, minimal, and bounded by construction; the full unit suite passes (552/552, 2 skipped) and `tsc --noEmit` is clean. Two findings were raised at review time and both were fixed in the same PR: the OpenAPI schema documented `fit_score` with the wrong range — directly the contract this fix exists to enforce — and there was no CHANGELOG entry, which this repo treats as part of every change.

A third instance of the same drift was **missed by this review and caught by Copilot**: `openapi.ts:80`, the `/match` operation description, still read *"Returns a percentage score"* after `:106` was corrected. Recorded rather than quietly fixed, because the miss is the lesson — see Inputs for /retro.

## Structural exception — no in-repo plan

This work was a patch on the lighter cadence: it originated from issue #240 and an investigation, not from a feature plan with a deliverables table. Per the `/review` edge case, roles below are the **de-facto owners** — the skills `/retro` would edit if this surfaced a lesson:

- `/backend-architect` — `src/lib/score-match.ts` scoring logic and the published API contract
- `/test-engineer` — `tests/score-match-bounds.test.ts`

Issue #240's **Expected** section is used as the de-facto AC.

## Deliverables ↔ Code

| Deliverable (from #240) | Implementation | Status |
|---|---|---|
| D1 — skills sub-score cannot exceed 1.0 | `src/lib/score-match.ts:41-71` (`skillsScore`), called at `:145` | ✓ shipped |
| D2 — `fit_score` stays within 0..1 | Follows from D1 **only if** experience/domain are in range — see finding 3 | ⚠ partial |
| D3 — "every sub-score" stays within 0..1 | — | ⚠ deliberately deferred |

### Code changes not tied to any deliverable

None. The diff is `skillsScore` + its call site, one test file, and the `test:unit` registration.

Scope decisions made deliberately and recorded here so they are not read as oversights:

- **Sub-factor validation omitted.** Measured 8/8 valid across live runs (`.scratch/new-shape-arm.ts`); the failure has never been observed. Adding it would be speculative hardening inside a bug fix.
- **`n = 0 → null` omitted.** Would introduce a new failure path, and `job-hunt-agent/src/scout-mail.ts:161` has no per-item catch, so a null there aborts an entire unattended scout-mail run rather than skipping one listing.
- **No prompt/rubric edit.** Deliberate given this repo's prompt-attention history.

## ACs ↔ Tests (Gate 3 spot-check)

| AC | Test file | Asserts invariant? | Notes |
|---|---|---|---|
| Reported payload no longer exceeds 1.0 | `tests/score-match-bounds.test.ts:28` | ✓ | asserts `<= 1` **and** the exact value `7.5/9` — the relation, not a literal pinned from the producer |
| Bounded for arbitrary overflow | `:35` | ✓ | table-driven over 5 shapes incl. the live-observed `13/1/2 vs 14` |
| Dropping a requirement costs | `:49` | ✓ | asserts `5/9`, which is the invariant a bucket-only denominator would break |
| No-op when lists agree | `:57` | ✓ | genuine regression guard — pins that unbroken scores do not move |
| Empty required list | `:63` | ✓ | pins the old `|| 1` inflation path at 1.0, not 5.0 |
| Both lists empty | `:69` | ✓ | asserts finite **and** 0 — catches NaN/Infinity separately |

No weak or vacuous assertions. Each case asserts a relation the implementation could plausibly get wrong, not a constant the implementation also hardcodes.

**Trap avoided:** `test:unit` is an explicit file list, not a glob — per the 2026-08-04 CHANGELOG entry, a new test file otherwise silently never runs. `tests/score-match-bounds.test.ts` is registered in `package.json:17`.

## Docs drift

| Location | Claim | Contradicted by | Severity |
|---|---|---|---|
| `src/routes/openapi.ts:106` | `fit_score` — *"Overall fit percentage 0–100"* | `score-match.ts:157` returns `round2(0.5·skills + 0.3·exp + 0.2·domain)`, max 1.0. Every payload in `README.md:367` and `docs/workflow.md:89` shows 0.82 / 0.81 | **High** |

This is the machine-readable schema on a surface whose stated premise is machine explorability, and it misstates the range of the exact field #240 is about. An agent reading it would expect 0–100 and receive 0.82 — a 100× misread that no range check catches because 0.82 is valid under both readings.

Checked and **not** stale: `docs/workflow.md:117` ("skills 50%, experience 30%, domain 20%") — weights unchanged. `docs/workflow.md:119-121` `recommended_action` thresholds — unchanged. Example payloads in `README.md` / `docs/workflow.md` — still representative.

## Recommendations

1. **Fix `src/routes/openapi.ts:106`** to `'Overall fit score, 0–1'` before committing. It is one line, it is in the same contract this change enforces, and shipping the bound while leaving the published range wrong is the more confusing half-state.
2. **Add a CHANGELOG `[Unreleased]` entry.** Every recent change carries one, and it is where this repo records the *why*. It should state plainly that the fix bounds the score and does **not** address the score inflation — measured at 109/112 still qualifying at 0.65 after the change.
3. **Do not let #240 close the inflation question.** `job-hunt-agent`'s `run-scout-mail.bat` restore condition reads "once `/match` returns scores inside 0-1 again", which this change now satisfies without changing the qualifying population. Restoring `apply:batch` on that basis would tailor ~100 resumes unattended. The condition should be rewritten against the distribution.

## Inputs for /retro

- **Route:** `/backend-architect` → `~/.claude/commands/backend-architect.md`
  **Draft principle:** *"When a numeric field's valid range is the contract consumers rank or threshold on, the range belongs in the published schema and must be verified against the producer whenever the computation changes. A range stated only in prose or implied by example payloads drifts silently — a 0–1 score documented as 0–100 stays undetected because every real value is valid under both readings."*
  **Triggered by:** `openapi.ts:106` advertising 0–100 for a 0–1 field, undetected across every prior change to `/match`.

- **Route:** cross-cutting → `/review` Step 3 (docs drift scan)
  **Draft addition:** *"When a docs-drift scan finds a stale claim, grep the whole file for the same claim restated in prose before declaring the finding closed. A schema and its human-readable description are two copies of one contract, and fixing the machine-readable one alone leaves the file internally inconsistent."*
  **Triggered by:** Step 3 grepped for the field name and range literals, matched `openapi.ts:106`, and missed `openapi.ts:80` — the same claim as the word "percentage", in the operation description 26 lines above. Copilot caught it on PR #241.

- **Route:** `/backend-architect` → `~/.claude/commands/backend-architect.md`
  **Draft principle:** *"When two model-generated lists are meant to describe the same set, do not assume they agree — derive any ratio over them from `max()` of both, never from one. Collapsing them into a single list removes the disagreement but also removes the signal, letting the producer shrink numerator and denominator together and inflate the result while staying in range."*
  **Triggered by:** the measured failure of the single-array redesign — ExpertVoice 1.06 → a clean-looking 1.00 by dropping 4 of 9 requirements.

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md` (fits alongside Rule 9 — sample the structurally worst-shaped member)
  **Draft principle:** *"When fixing an out-of-range defect, include a no-op regression case asserting that in-range inputs are unchanged. A bound that also silently moves correct values is a re-ranking, not a fix, and only the negative case detects it."*
  **Triggered by:** `:57`, which is what establishes that 8 of 12 measured production runs are unaffected.

- **Route:** cross-cutting → investigation practice
  **Draft note:** *"Before proposing an output-shape change to a model-backed scorer, measure the proposed shape against live output. Boundedness that holds by construction can still be satisfied by the model degrading its output — a shape the model can satisfy trivially is worse than one it can violate visibly."*
  **Triggered by:** two successive proposals (two-call split, single-array shape) that both passed reasoning and failed measurement.
