# Plan: JD-Driven Quality Extraction for `/match` Experience & Domain Scoring

**Branch:** `feat/match-quality-extraction`
**Status:** Planning — not started
**Scope:** Replace `/match`'s fixed, employer-agnostic `experience`/`domain` rubric with the same JD-driven extract-then-score pattern `skills` already uses, so `fit_score` reflects what each specific JD actually asks for instead of converging on a near-constant baseline.

---

## Context

`fit_score = 0.5 * skills_score + 0.3 * exp_score + 0.2 * domain_score` (`src/lib/score-match.ts:159`).

PR #241 bounded `skills_score` to 0..1 but surfaced, without fixing, a second defect: on 112 real stored shortlist entries (`job-hunt-agent`'s scout-mail pipeline), `experience` has p50 exactly 1.00 with sd 0.053. `experience + domain` together contribute a near-constant 0.41 ± 0.03, so `fit_score ≈ 0.41 + 0.5 × skills` — the bottom ~40% of the scale is unreachable regardless of actual fit.

Root cause, established through discussion in this thread (not a formal issue write-up — recorded here instead):

1. **`skills` already does extraction-first scoring.** It extracts `required_skills_extracted` from the JD text, then scores `matched`/`partial`/`missing` against only that list (`skillsScore`, `src/lib/score-match.ts:66`).
2. **`experience`/`domain` never do.** They're scored directly against a fixed six-sub-factor rubric (`years`/`scope`/`recency`, `industry`/`product_type`/`scale`) applied identically to every JD, whether or not that JD signals anything on a given axis. The model fills in plausible defaults for axes nobody asked it to reason about — that's the near-constant baseline.
3. **A scalar "years" comparison is separately unreliable.** The profile carries no structured years field, only free-text ("6+ years") in `summary` — deliberately, since "years of experience in X" doesn't reduce to one number when the underlying work doesn't cleanly map to one continuous tenure. Concretely: ~3+ years since the candidate's last W2 role, of which ~2+ is exploratory work with no verifiable artifact and ~1 is AI/LLM-focused work backed by real commit history (`projects[].git_evidence` — `commit_count`, dates, signed provenance). `employment` entries carry no such evidence — prose bullets and dates only.
4. **Generalized fix:** give `experience`/`domain` (and any other quality a JD raises) the same two-step treatment `skills` gets — extract what *this* JD/employer actually cares about, then score coverage against exactly that, weighted by how much the JD emphasizes each item and by how well the candidate's history evidences it (verified > claimed > absent) — rather than forcing every JD through the same six fixed boxes with fixed 0.5/0.3/0.2 weights.

## Decisions confirmed 2026-08-12 (owner sign-off, not open)

| Decision | Answer | Why |
|---|---|---|
| Evidence source | **Live-derived** from the existing profile JSON already sent to the model (`projects[].git_evidence`, `employment[].start_date`/`end_date`/bullets). No schema/migration to tag `employment` entries. | Lower risk, ships without a backfill burden. **Caveat the owner raised and this plan treats as a first-class requirement, not a footnote:** coding the evidence-weighing procedure correctly does not guarantee the model *applies* it consistently call to call. This must be checked empirically (D6), not assumed from a correct-looking prompt. |
| Call architecture | **Single combined call** — extraction + scoring in one response, same shape `skills` already uses today. | No added latency/cost over current behavior; proven pattern. |
| Aggregation | **Fully dynamic per-JD weighted quality list.** `fit_score` becomes a weighted average over whatever qualities a given JD actually raised — not a fixed 3-bucket/0.5-0.3-0.2 split. | Most faithful to "score what this employer cares about." Explicitly accepted tradeoff: `job-hunt-agent`'s `apply:batch` threshold must be re-validated against the new distribution as **part of this workstream (D10)**, not a deferred cleanup. |

## Downstream contract check (`job-hunt-agent`)

Grepped `job-hunt-agent/src/*.ts` for every field it reads off the `/match` response (`src/match.ts:8-15` is its local `FitResult` type):

- `fit_score` (number) — thresholded and sorted in `scout-mail.ts`, `discover.ts`; read in `apply-batch.ts`, `apply-core.ts`.
- `verdict` (string) — logged/printed only.
- `matched` (string[]) — rendered verbatim into candidate-facing email copy (`email.ts:27`, `"Candidate strengths for this role: ${fit.matched.join(', ')}"`) and OB1 logging.
- `gaps` (string[]) — fed to `buildFramingHints()` (`apply-core.ts:76`, `discover.ts:85`).
- `recommended_action` (string) — typed but not currently branched on.
- `scoring` — typed as **`Record<string, unknown>`** (`src/match.ts:14`). Opaque. Nothing on the `job-hunt-agent` side destructures `experience`/`domain` internals.

**Implication:** the internal `scoring` shape (exactly what D1/D2 redesign) is free to change with zero `job-hunt-agent` code changes, because it's already untyped there. `matched`/`gaps` are the only fields with real downstream semantics, and both are rendered as human-readable phrases in email/framing copy — so this plan keeps them **skill-scoped**, matching their current meaning, rather than letting them absorb the new experience/domain-shaped qualities. The dynamic quality list (with its category/importance/evidence detail) lives inside `scoring` only. This avoids a `job-hunt-agent`-side contract change entirely for D1-D9; the only required downstream follow-up is D10 (threshold recalibration), because the *scoring math* changes even though the *shape* `job-hunt-agent` reads does not.

**Correction from `/review` (`docs/plans/match-quality-extraction-review.md`): this check stopped one repo short.** `resume-agent-web` (also README-listed, at `github.com/yuens1002/resume-agent-web`) destructures `scoring` directly and is not untyped there: `src/lib/types.ts` hand-mirrors `MatchScoring`, and `src/components/MatchResume.tsx` renders `result.scoring.skills.score` / `.experience.score` / `.domain.score` against hardcoded "50%"/"30%"/"20%" weight labels — exactly the fixed shape and split this plan removes. `scoring` is **not** free to redesign with zero downstream code changes; see D11.

## Non-goals

- No `employment` schema change or category-tag backfill (per confirmed decision above).
- No change to `matched`/`gaps` semantics — stays skill-scoped; see contract check above.
- No two-stage (extract-call, then score-call) architecture (per confirmed decision above).
- No re-litigating #240/#241's already-decided scope (sub-factor input validation, `n = 0 → null` handling) — those scope calls stand.
- Unrelated to `docs/privacy-surface-audit.md` (separate in-flight workstream on thought visibility — do not conflate).

## Proposed shape (for `/backend-architect` to finalize exact field/enum names during D1)

```ts
interface RawScores {
  required_qualities: Array<{
    name: string                                   // e.g. "TypeScript", "AI/LLM engineering experience", "healthcare domain"
    category: 'skill' | 'experience' | 'domain'
    jd_importance: 'must_have' | 'preferred'
  }>
  scored_qualities: Array<{
    name: string
    category: 'skill' | 'experience' | 'domain'
    verdict: 'matched' | 'partial' | 'missing'
    evidence_grade: 'verified' | 'claimed' | 'absent'  // verified = backed by git_evidence/dated employment; claimed = prose only; absent = no support found
  }>
  verdict: string
}
```

`fit_score` generalizes `skillsScore`'s bounded-by-construction discipline (#240) rather than replacing it with a clamp: per-quality credit is a function of `verdict` × `evidence_grade` (e.g. matched+verified=1.0, matched+claimed=0.8, partial+verified=0.5, partial+claimed=0.4, missing=0 — exact multipliers are a D1 implementation detail, not a planning decision), weighted by `jd_importance`, and the denominator is `max(|required_qualities|, |scored_qualities|)` generalized the same way `skillsScore` already aligns its two lists — so a dropped requirement still costs what it should and an overflowing bucket list still can't push the score past 1.0.

## Deliverables

| ID | Deliverable | Kind | Owning role |
|----|---|---|---|
| D1 | `src/lib/score-match.ts` — replace fixed `SCORING_RUBRIC` + `RawScores` + `scoreMatch` aggregation with the extraction-first, weighted-quality design above. Retires `skillsScore` (see D7). Includes three spike-derived additions (2026-08-12): (a) a cheap `normalizeNumericNotation` preprocessing step on JD text — comma-grouped digits and k/K suffixes collapse to plain integers before the JD reaches the model; free, not proven necessary by the spike but zero-risk; (b) the EXTRACT step's instruction uses the tightened wording from spike round 3 ("explicitly states as a requirement... not merely descriptive company/role context") rather than the looser "explicitly states or clearly implies," which measurably reduced cross-model extraction disagreement on one of two tested phrasings; (c) a truncation-retry on the model call, matching the existing `/query` pattern (PR #210) — the spike hit 2 truncations on `gemini-3.6-flash` across ~24 calls even with explicit `maxTokens: 2048`, so this is a real risk, not hypothetical | lib logic | `/backend-architect` |
| D2 | `src/types.ts` — update `MatchScoring` to carry `required_qualities`/`scored_qualities` detail; `MatchResponse` top-level (`fit_score`, `matched`, `gaps`, `verdict`, `recommended_action`) unchanged | types | `/backend-architect` |
| D3 | `src/routes/openapi.ts` **and** `README.md:382-406` ("Agentic job match methodology") — update both the machine-readable schema and the public narrative doc for the new `scoring` shape. README currently states the exact fixed weighting (skills 50% / experience 30% / domain 20%) this plan removes — added per `/review`, was previously openapi.ts-only and missed this | docs/schema | `/backend-architect` |
| D4 | `scripts/eval/match-eval-cases.ts` — rework the existing 21-case held-out set from fixed-axis scalar-bucket expectations to quality-extraction expectations (which qualities a JD should raise, with what `jd_importance`, and the expected `verdict`/`evidence_grade` given the documented candidate ground truth already in the file) | test fixture | `/test-engineer` |
| D5 | `scripts/eval/run-match-eval.ts` (new) — executes `MATCH_EVAL_CASES` against live `scoreMatch`, diffs actual vs. expected per-quality verdict/evidence_grade, and reports the resulting `experience`/`domain` score distribution so the compression this plan targets is directly observable, fixed or not | script | `/test-engineer` |
| D6 | `tests/match-quality-consistency.test.ts` (new) — the empirical check for the owner's stated concern, now informed by 3 spike rounds (2026-08-12). Three dimensions, not one: (1) same-model repeatability — N=5 repeats on anchor-high, anchor-low, and `scale-different-large-enterprise` on the default model (`MATCH_MODEL`); (2) cross-model agreement — one pass each on `google/gemini-3.6-flash` and `openai/gpt-5.6-luna-pro` against the same cases, testing whether the *rubric* is well-specified enough for independent models to converge, not just whether one model is internally noisy; (3) **phrasing invariance** (replaces an earlier, spike-disproven "numeric notation invariance" idea) — the same underlying requirement expressed as a raw number, a plain description, and a named idiom (the spike's `50,000+ employee` / `massive, tens-of-thousands-strong` / `Fortune 500 scale` triad) is what actually moved cross-model agreement, not number formatting. `scale-different-large-enterprise`-style cases are expected to show **bounded, not zero**, disagreement even after rubric tightening — treat as a Rule 10 "Reproduced" case, not a bug to fully eliminate. Requires `scoreMatch` to accept an optional model override (small D1 addition — `getModel()` already supports this per-call) so the test calls the real code path against each model | test | `/test-engineer` |
| D7 | `tests/score-match-bounds.test.ts` — **RESOLVED via spike (2026-08-12): migrate, don't keep alongside.** `skillsScore` is retired in D1 — every spike result scores `skill`-category qualities through the same generic mechanism as `experience`/`domain`, so a separate helper would be a redundant parallel implementation. Rewrite the #240 tests as cases of the new generic aggregation-bound tests rather than keeping the old function's dedicated suite | test | `/test-engineer` |
| D8 | `package.json` — register D5 as an npm script (`eval:match`) and add D6 + D7 to the explicit `test:unit` list (confirmed not a glob — a new file silently never runs otherwise) | config | `/backend-architect` |
| D9 | `CHANGELOG.md` + version bump — per this repo's own convention (every change gets an entry; #241's review flagged this exact repo's discipline) | docs | `/backend-architect` |
| D10 | `job-hunt-agent` (separate repo, separate PR, sequenced **after** D1-D9 ship to production) — re-score a fresh real sample through the new `/match`, compare the resulting `fit_score` distribution against the current 0.65/0.76 thresholds in `scout-mail.ts`, and update the "TO RESTORE" condition comment in `scripts/run-scout-mail.bat` to reflect the actual new condition | cross-repo script | `/backend-architect` |
| D11 | `resume-agent-web` (separate repo, separate PR, sequenced **after** D1-D9 ship to production) — `src/components/MatchResume.tsx` + `src/lib/types.ts` (local `MatchScoring`/`MatchResponse` mirror) + `prototype/DESIGN-HANDOFF.md`: replace the fixed three-bar (skills 50%/experience 30%/domain 20%) rendering with one that handles a variable-length dynamic quality list. Added per `/review` — this consumer destructures `scoring.experience.score`/`scoring.domain.score` directly and breaks at runtime under D1/D2 without it; the original downstream-contract check stopped at `job-hunt-agent` and missed it | cross-repo UI | `/frontend-dev` |

## Acceptance Criteria

### Functional

| AC | Plan ref | Role | What | How | Pass | Agent | QC |
|----|---|---|---|---|---|---|---|
| AC-FN-1 | D1 | `/backend-architect` | `scoreMatch` extraction step | Code review: `src/lib/score-match.ts` | Rubric prompt asks the model to name the qualities *this JD* raises across skill/experience/domain before scoring any of them — no fixed sub-factor is scored without first appearing in `required_qualities` | PASS — `score-match.ts:101-125`; carve-out separating role scope (extract) from company context (don't) confirmed present, incl. the mid-implementation regression fix | PASS · confirmed by re-running the 4 previously-failing scope cases live after the fix |
| AC-FN-2 | D1 | `/backend-architect` | `fit_score` bound | Code review + AC-TST-1 | `fit_score` cannot exceed 1.0 or fall below 0.0 by construction (denominator ≥ numerator per quality, weighted average is bounded by its terms) — no `Math.min`/`Math.max` clamp papering over an unbounded formula | PASS — algebraic trace confirmed (`score-match.ts:168-180`), no clamp found | PASS · same conclusion independently, plus 11/11 `score-match-bounds.test.ts` green |
| AC-FN-3 | D2 | `/backend-architect` | `MatchResponse` top-level stability | Code review: `src/types.ts` + diff against `job-hunt-agent/src/match.ts`'s `FitResult` | `fit_score`, `matched`, `gaps`, `verdict`, `recommended_action` field names/types unchanged; `matched`/`gaps` still populated from skill-category qualities only | PASS — field set unchanged, cross-checked live against `job-hunt-agent/src/match.ts:8-15`'s opaque `Record<string, unknown>` scoring type | PASS · spot-checked |
| AC-FN-4 | D3 | `/backend-architect` | OpenAPI schema + README methodology accuracy | Code review: `src/routes/openapi.ts` **and** `README.md:382-406` | Neither file describes the old fixed `experience{years,scope,recency}`/`domain{industry,product_type,scale}` objects or the 50/30/20 weighting anywhere — both describe the extraction-first, dynamic-weight design (#241's review caught exactly this class of miss at `openapi.ts:80`; this AC extends the same check to the narrative doc, which the original plan missed entirely — see `/review`) | PASS — grepped both files for old-shape terms, zero hits | PASS · trust |

### Test Coverage

| AC | Plan ref | Role | What | How | Pass | Agent | QC |
|----|---|---|---|---|---|---|---|
| AC-TST-1 | D7 | `/test-engineer` | Weighted-quality aggregation bound | Test run: `npm run test:unit` | `tests/score-match-bounds.test.ts` asserts the new aggregation stays within 0..1 across overflowing/empty/aligned list shapes, mirroring the #240 cases for the old `skillsScore` | PASS — 11/11 cases pass; bound asserted as `score >= 0 && score <= 1` invariant, not literal equality (equality reserved for exact regression-math checks) | PASS · re-ran independently, matches |
| AC-TST-2 | D4, D5 | `/test-engineer` | Held-out quality extraction | Test run: `npx tsx scripts/eval/run-match-eval.ts` (live model calls — not part of `test:unit`) | Anchor-high case extracts/matches ≥90% of its qualities as `matched`+`verified` or `matched`+`claimed`; anchor-low extracts/scores ≥90% as `missing` or `partial`+`absent`; per-axis groups (years/scope/recency/industry/product_type/scale-equivalent JDs) show visible spread across cases rather than clustering — report actual sd, don't just eyeball it | PASS — ran live independently (21 cases, ~6 min): 27/27 expectations, anchors 4/4 each (100% ≥ 90% bar), `fit_score sd=0.224` vs #241's `sd=0.053` baseline, per-axis spread confirmed (e.g. scope: 0.97/0.93/0.45) | PASS · own run (sd=0.215) landed within noise of the sub-agent's independent run (sd=0.224) — two separate live runs, consistent conclusion |
| AC-TST-3 | D6 | `/test-engineer` | Judgment consistency — same-model repeatability | Test run: `npx tsx --test tests/match-quality-consistency.test.ts` (live model calls, `MATCH_MODEL`) | Per `/test-engineer` Rule 10 (Reproduced vs. Argued): the sample MUST include at least one deliberately ambiguous case (e.g. `scale-different-large-enterprise`) alongside the two anchors — anchors alone can pass trivially without exercising real judgment. Across N=5 repeated runs, `verdict`/`evidence_grade` per named quality **disagree in <10% of runs** (owner-confirmed 2026-08-12); the Pass cell states which cases are expected to show bounded disagreement (Reproduced) vs. stay stable (Argued), not one undifferentiated bar; disagreements are logged with the actual diverging outputs, not silently averaged away | PASS — file inspection confirms the design is correctly implemented (anchors assert 0 disagreements = <10% at N=5; ambiguous case asserts only a sanity bound + logs actual rate). Live run (main thread, twice): 7/7 pass, ambiguous case showed real 20% extraction-rate variance (1/5 runs), logged not asserted-away | PASS · live-ran twice myself; the retry-ceiling bug this run surfaced (see AC-REG-1 notes) was fixed and reconfirmed before this AC closed |
| AC-TST-4 | D6 | `/test-engineer` | Judgment consistency — cross-model agreement | Test run: same file, single pass each on `google/gemini-3.6-flash` and `openai/gpt-5.6-luna-pro` via `scoreMatch`'s model override | Same sample as AC-TST-3, run once per additional model instead of N=5 times on one model. Report per-quality agreement rate against the `MATCH_MODEL` baseline on the SAME cases — this is diagnostic, not gating, on first run (no prior baseline exists yet); the tolerance for treating cross-model disagreement as a failure is set after seeing the first real results, not guessed in advance (see Open Item 4 discussion) | PASS — file inspection confirms diagnostic-not-gating framing; model-override param confirmed present in `scoreMatch`'s signature | PASS · live results: fit_score diffs of 0.02 and 0.04 vs default on the unambiguous anchor — small, as expected |

### Regression

| AC | Plan ref | Role | What | How | Pass | Agent | QC |
|----|---|---|---|---|---|---|---|
| AC-REG-1 | — | `/test-engineer` | All existing tests pass | Test run: `npm run test:unit` | 552+ tests pass, 0 failures (baseline per #241; grows with D6/D7's new files) | PASS — 559 tests, 557 pass, 0 fail, 2 pre-existing skips | PASS · same result |
| AC-REG-2 | — | `/backend-architect` | Type/lint clean | Test run: `npx tsc --noEmit` | 0 type errors | PASS — exit clean, zero output | PASS · same |
| AC-REG-3 | D8 | `/backend-architect` | New test files actually run | Code review: `package.json` `test:unit` script string | ~~D6 and D7's file paths are present in the explicit list (not assumed via glob)~~ **Corrected post-verification:** D7's file is in the explicit `test:unit` list. D6 deliberately is NOT — it makes live model calls (requires `OPENROUTER_API_KEY`), matching this repo's own established pattern for every other live-model suite (`test:integration`, `test:transport`, `test:oauth`, `test:public-mcp` — none are in `test:unit` either). D6 gets its own `test:match-consistency` script instead. Folding it into `test:unit` would break CI (no key present) or add live-cost/flakiness to the fast suite | WEAK → **corrected**: literal Pass-cell text was stale relative to a sound implementation decision, not an unmet AC. Verified `tests/score-match-bounds.test.ts` (D7) is in `test:unit`; `tests/match-quality-consistency.test.ts` (D6) has its own script (`package.json:24`) | PASS · agreed the deviation is correct; fixed the Pass-cell wording in this row rather than the code |

### Cross-repo (sequenced after D1-D9 ship)

| AC | Plan ref | Role | What | How | Pass |
|----|---|---|---|---|---|
| AC-XR-1 | D10 | `/backend-architect` | `job-hunt-agent` threshold still meaningful | Script run against a fresh real sample + `job-hunt-agent/scripts/run-scout-mail.bat` comment diff | Documented distribution shift (old vs. new `fit_score` on the same sample) and an explicit updated threshold recommendation, replacing the current "TO RESTORE" condition with one that reflects the actual new scoring behavior |
| AC-XR-2 | D11 | `/frontend-dev` | `resume-agent-web`'s match UI doesn't break | Browser: navigate to the deployed `resume-agent-web` match page, submit a JD, capture screenshot `ac-xr-2.png` | Renders the dynamic quality list without a runtime error and without any hardcoded "50%"/"30%"/"20%" weight label; `src/lib/types.ts`'s local `MatchScoring` mirror matches resume-agent's new `src/types.ts` shape |

## Open items

1. **RESOLVED via spike 2026-08-12** — schema confirmed workable across 3 models; use the tightened EXTRACT instruction from spike round 3 as D1's starting rubric text (see "Spike results" below). Exact credit multipliers for `verdict × evidence_grade` and the `jd_importance` weight ratio are still a D1 implementation detail — `/backend-architect` finalizes and documents the reasoning the way #240's docstring does, not just lands the numbers.
2. **RESOLVED 2026-08-12** — D6's same-model disagreement tolerance is **<10%** (i.e. verdict/evidence_grade must agree on ≥9 of 10 runs, scaled to whatever N is actually used). Applied to AC-TST-3.
3. **RESOLVED via spike 2026-08-12** — `scale-different-large-enterprise` stays in the D4 fixture, reframed as an expected-bounded-disagreement case (Rule 10 "Reproduced"), not a case to keep tuning toward full agreement. `/test-engineer` reworking the other 20 cases should apply the same lens: flag genuine ambiguity as a feature of the test, not a defect to fix before D4 is "done."
4. **RESOLVED via spike 2026-08-12** — `skillsScore` is retired, not kept alongside. See D1/D7.

## Spike (before D1 is implemented for real)

Owner requested (2026-08-12): run a small number of real held-out cases through a draft of the new extraction-first rubric, on the default model plus the two D6 cross-model additions, and look at the actual raw output together before finalizing the exact schema (Open Item 1), the ambiguous-case calls in D4 (Open Item 3), and whether `skillsScore` survives as a helper (Open Item 4). This is exploratory — a throwaway script, not D1 itself — and its output is what Open Items 1/3/4 get resolved against, not further paper discussion.

Suggested scope for that spike: 3-4 cases from the 21 (at minimum `anchor-high`, `anchor-low`, and the deliberately ambiguous `scale-different-large-enterprise`), one draft rubric prompt implementing the "Proposed shape" above, run once on `MATCH_MODEL` and once each on `google/gemini-3.6-flash` / `openai/gpt-5.6-luna-pro`, raw JSON output shown unmodified.

### Spike results (3 rounds, run 2026-08-12 — `.scratch/quality-extraction-spike*.ts`, not committed)

**Round 1 — schema + anchors + `scale-different-large-enterprise`, 3 models.**

- Schema confirmed workable: all three models correctly followed the extraction-first shape once the model ID was right (an early `MATCH_MODEL` mismatch in the spike script itself, not a production issue — corrected mid-run).
- `anchor-low` correctly floors on every model (all qualities `missing`/`absent`) — direct evidence against the "model ceiling" hypothesis; the fixed-rubric structure, not model sycophancy, was the real root cause, as diagnosed.
- `scale-different-large-enterprise` split 2-1: `gemma-it` and `gpt-5.6-luna-pro` extracted no scale-related quality at all (read "50,000+ employee" as company context, not a stated candidate requirement); `gemini-3.6-flash` extracted it as `preferred` and credited it via Wipro. First confirmation this case is genuinely, reproducibly ambiguous — at the **extraction** step, not just the scoring step.
- `gemini-3.6-flash` truncated mid-JSON on `anchor-high` despite explicit `maxTokens: 2048`.

**Round 2 — numeric notation vs. semantic paraphrase, same underlying "big company" concept.**

- Notation variants ("50,000+" / "50000+" / "50k+") produced **identical** behavior raw, and normalization changed nothing — the mechanical-notation concern didn't manifest here. Per #241's own precedent, kept the cheap normalizer as free insurance (see D1), not as a fix for a confirmed problem.
- Semantic-paraphrase variants of the same concept ("50,000+ employee..." / "a massive, tens-of-thousands-strong..." / "Fortune 500 scale") showed the real variance: raw number and plain description both got the same 2-of-3-silent pattern; naming a recognizable idiom ("Fortune 500") flipped all three models to extracting *something*, while they still split on `evidence_grade` (verified vs. claimed).

**Round 3 — tightened EXTRACT instruction (removed "or clearly implies"; explicit "descriptive company context ≠ candidate requirement" carve-out), same 3 phrasings, all 3 models.**

- "50,000+ employee" — unchanged, still 3/3 not-extracted.
- "massive, tens-of-thousands-strong" — **fixed**: the one outlier (`gemini-3.6-flash`) now agrees with the other two (not extracted). The instruction tightening measurably worked here.
- "Fortune 500 scale" — still contested: `gemma-it` still extracts, `gpt-5.6-luna-pro` now flips to not-extracting, `gemini-3.6-flash` truncated again (unreadable, second truncation across the spike). Read as a genuinely hard case — "Fortune 500 scale" is common JD shorthand for an *implied* experience requirement, not pure description — rather than a rubric-wording failure to keep chasing.

**Decisions this resolves:**

- **Open Item 1 (schema)** — RESOLVED. Use the shape in "Proposed shape" with the tightened EXTRACT instruction from round 3 as D1's starting rubric text.
- **Open Item 3 (ambiguous cases in D4)** — RESOLVED, and sharpened. `scale-different-large-enterprise` stays in the fixture, but reframed: not a case to fix until models agree, but a case D6 uses to test that disagreement stays *bounded*, per `/test-engineer` Rule 10 (Reproduced vs. Argued) — some genuine ambiguity is expected and should be measured, not eliminated.
- **Open Item 4 (`skillsScore`'s fate)** — RESOLVED: retire it. Every clean spike result scores `skill`-category qualities through the exact same verdict×evidence_grade mechanism as `experience`/`domain` — nothing about skill-scoring is structurally special under this design anymore. Migrate the #240 tests into the new generic aggregation-bound tests (D7) rather than keep a redundant parallel implementation.
- **New finding — truncation is real, not hypothetical.** `gemini-3.6-flash` truncated on 2 of ~24 spike calls, different cases, same explicit `maxTokens: 2048`. D1 needs a truncation-retry (this codebase already has the pattern for `/query`, PR #210), not just a higher ceiling.
- **New finding — mechanical notation normalization is free but unproven.** Keep it in D1 (harmless, zero measured cost) but don't credit it with fixing anything — the round 2 data showed no notation-driven variance to fix.

## Gate 1 self-check (manual — this repo has no `scripts/check-acs-coverage.ts` validator)

- Every deliverable (D1-D11) has ≥1 AC row citing its ID: D1→AC-FN-1/2, D2→AC-FN-3, D3→AC-FN-4, D4/D5→AC-TST-2, D6→AC-TST-3, D7→AC-TST-1, D8→AC-REG-3, D9→ (glue deliverable, no dedicated AC — CHANGELOG presence is checked at `/review`, per this repo's own stated convention rather than a testable AC), D10→AC-XR-1, D11→AC-XR-2. (D11 added post-hoc by `/review`, `docs/plans/match-quality-extraction-review.md` — the original downstream-contract check missed this consumer.)
- No `Role` column entry is `TBD`.
- Spot-check Gate 2: AC-TST-1 phrases an invariant ("stays within 0..1 across overflowing/empty/aligned shapes"), not a config-literal equality.

## Commit schedule

1. `docs: add plan for match quality-extraction redesign` — this doc.
2. `feat(match): extraction-first quality scoring for experience/domain` — D1, D2, D3.
3. `test(eval): rework match held-out set for quality extraction` — D4, D5.
4. `test(match): consistency + bounds coverage for weighted quality aggregation` — D6, D7.
5. `chore: register match eval script, changelog` — D8, D9.
6. `/review`, human review, `/release`.
7. Separate PRs, after (6) ships to production — D10 (`job-hunt-agent`, threshold recalibration) and D11 (`resume-agent-web`, match UI update) — sequenced together since both depend on the same production deploy, but are independent repos/PRs.
