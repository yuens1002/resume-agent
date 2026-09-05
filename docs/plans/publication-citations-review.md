# /review report — publication citations in `/query` (#177 chunk 2)

**Branch:** `feat/177-publication-citations`
**Generated:** 2026-09-05
**Iterations to reach verified:** 3 (Phase 3 verification → Phase 4.4 `/ocr-review` → live smoke)

## Verdict

**Minor issues — approve-able.** All 25 ACs pass, `PROMPT_VERSION` is byte-identical to `main`, and the feature works live in both styles. Two documentation omissions found by this pass (CHANGELOG and README) were fixed in it. The remaining items are low-severity findings deliberately left unfixed, listed below for your call, plus one scope note about the streaming path that is documented rather than solved.

The headline: this change did **not** need the prompt edit the parked branch attempted. Publications already reached the model; only the citation *form* was wrong. Fixing it deterministically removed the entire attention-displacement risk that caused the July park.

## Deliverables ↔ Code

| Deliverable | Implementation | Docs touched? | Status |
|---|---|---|---|
| D1 — pure resolver + normalizers | `src/lib/publication-citations.ts` (new, 300 lines) | Y | ✓ shipped |
| D2 — `/query` wiring + empty-key drop | `src/routes/query.ts:245-256` (prompt), `:379` (array binding), `:503-512` (normalize), `:519` (envelope) | Y | ✓ shipped |
| D3 — types | `src/types.ts:66-73` (`PublicationCitation`), `:177` (`QueryResponse.publications`) | Y | ✓ shipped |
| D4 — OpenAPI | `src/routes/openapi.ts:56-70` | Y | ✓ shipped |
| D5 — engagement-rules doc | `docs/query-engagement-rules.md` — new "normalized after generation, not prompted" section | Y | ✓ shipped |
| D6 — tests | `tests/publication-citations.test.ts` (new, 62 tests), `tests/thoughts-grounded-query.test.ts` (+5), `package.json` `test:unit` | Y | ✓ shipped |
| D7 — live smoke + `PROMPT_VERSION` identity | Run in-session against a local server on the live profile; evidence in AC-SMK-1/2 and AC-REG-1 | N/A | ✓ shipped |

### Code changes not tied to any deliverable

None. Every changed file traces to a deliverable. `README.md` and `CHANGELOG.md` were added by this review pass (see Docs drift → Missing updates), which is Step 3b closing its own finding, not scope creep.

## ACs ↔ Tests (Gate 3 spot-check)

25 ACs; sampled the load-bearing and the historically weak.

| AC | Test | Asserts invariant? | Notes |
|---|---|---|---|
| AC-FN-1 | `publication-citations.test.ts` index-form suite | ✓ | Resolves index 1 to the *second* fixture, so an always-`[0]` implementation fails |
| AC-FN-3 | sub-path suite | ✓ (after fix) | **Was WEAK.** Original assertion was vacuous — it checked "no URL" on the array surface, which carries no URL for *anything*. Deleting the real guard left the suite green. Now scoped to what it tests, with the prose behavior pinned separately |
| AC-FN-4 | prose-link suite | ✓ (after two rescopes) | Exact equality including the ` — ` separator; changing the separator now fails 5 tests |
| AC-FN-8 | index-over-malformed-array suite | ✓ | The Phase 3 defect. Pinned by a fixture with a slug-less row at position 0 |
| AC-FN-12 | prose-word suite | ✓ | The other Phase 3 defect. Pinned by an answer containing the bare word "publications" |
| AC-FN-14 | cache round-trip | **⚠ partial, honestly labeled** | The test proves cache *fidelity*, not ordering. Swapping `responseCacheSet` above the normalizers would still pass. The AC's QC cell now says "by code trace only" rather than crediting a test that cannot fail for it |
| AC-FN-19/20 | title-floor and index-cross-check suites | ✓ | Both mutation-verified |
| AC-REG-1 | n/a — measured, not tested | ✓ | All four `buildSystemPrompt` mode × style hashes byte-identical to `main`; `PROMPT_VERSION`'s only other input (`ROUTE_CLASSIFIER_RULE`) is untouched |
| AC-SMK-2 | n/a — live | ✓ | Remainder offer first in 5/5 independent generations |

**Mutation verification.** Rather than reasoning about whether tests are load-bearing, they were measured: 13 Phase-3 regressions all fail against the pre-fix implementation, and six mutations that the Phase 4.4 reviewer proved could survive the suite (sub-path link, Sources-block anchoring, the separator, the title floor, the index cross-check, envelope ordering) now each fail at least one test.

## Docs drift

### Stale claims (contradiction)

| Claim | Location | Contradicted by | Status |
|---|---|---|---|
| "`publications` (conversational `sources`) → `publications.<slug> — <canonical_url>`" | `docs/query-engagement-rules.md` normalization table | `normalizePublicationSourcePaths` emits the bare path, and a test asserts it | **Fixed** — table now splits prose vs array columns |
| "sub-path citations take no URL" | same table + AC-FN-3/4 rows | Live evidence: a model citing only `.title`/`.date` left the reader with no link. Contract changed to once-per-publication | **Fixed** in doc, ACs, and code |
| AC-FN-9 QC: "pinned by AC-FN-16/17" | `publication-citations-ACs.md` | Removing the Sources-block slice left the suite green — it was not pinned | **Fixed** — cell now states what was actually true and what pins it now |
| AC-FN-14 QC: credited a test | same | That test cannot fail for the ordering invariant | **Fixed** — restated as code-trace evidence |

### Missing updates (omission)

| Deliverable | Should have landed in | Status |
|---|---|---|
| D3 — new `/query` response field | `CHANGELOG.md` `[Unreleased]` — the repo logs response-shape additions here (precedent: the 2026-06-10 `project_slugs` entry, the same category) | **Fixed** in this pass |
| D3 — new `/query` response field | `README.md:342-350` `/query` response example | **Fixed** in this pass — added to the example plus a paragraph explaining the field |

`docs/workflow.md` also shows a `/query` response, but as an illustrative walkthrough of one question rather than a field enumeration; left alone deliberately.

### New-claim accuracy (overclaim scan)

Checked every "mirrors"/"same as"/"exactly"/"never" claim newly written in this diff against the implementation. Two were found overstated and corrected during Phase 4.4 (the two AC QC cells above). The module header's remaining strong claims — indices resolved against the raw array, prose rewriting confined to the Sources block, `PROMPT_VERSION` untouched — were each verified against the code and, for the last, against measured hashes.

One deliberate hedge retained: `docs/query-engagement-rules.md` says streaming responses "are not normalized" rather than implying the feature is complete everywhere. See Recommendations #1.

## Docs hygiene / public-voice audit

| Finding | Kind | Location | Introduced or pre-existing |
|---|---|---|---|
| Live publication slug + `Dev.to` named in plan prose | A (benign) | `docs/plans/publication-citations.md:13` | introduced |
| `agent.yuens.me` in the plan's D7 row | A (benign) | `docs/plans/publication-citations.md` deliverables table | introduced |

**Assessed as not findings.** Both refer to the owner's own already-public surfaces: the article is published on Dev.to under the owner's public handle, and `agent.yuens.me` appears in 9 existing repo docs plus `llms.txt` and the issue body. The repo's own convention is explicit that fork-local live-profile references are accepted in this doc class — `docs/query-engagement-rules.md:3` says "This doc's examples mirror the live profile; fork-local by design, see #202."

**No Kind A leak in code or tests.** Every test fixture is invented (`alpha-piece`, `beta-piece`, `example.test` URLs); the live slug appears in no test, no source file, and no AC Pass cell — confirmed by grep across the whole diff. This is the constraint the frozen spec named ("no owner name in code/comments/fixtures") and it holds.

**Kind B / Kind C:** none. No altitude mismatch (the durable docs state the general mechanism, not which publication currently exists), no first-person or maintainer-workflow voice.

This repo has no `.claude/oss-hygiene-rules.json`; nothing found here warrants creating one.

## Recommendations

1. **Open a follow-up for the streaming path.** `GET /query?stream=true` forces `cited` style, so a streamed answer *does* carry a prose `Sources:` block — which will contain the unnormalized `publications[0]` this feature exists to fix. Bytes are forwarded to the client before the response completes, so there is no cheap in-stream fix; it is scoped out consistently with the #215 guard, but the gap is publicly reachable and should be tracked rather than left in a doc sentence.
2. **`resume-agent-web` follow-up.** The envelope field is additive and nothing breaks without it, but the visitor-facing payoff — a "read the piece" link — only lands once the frontend renders it. Worth an issue in that repo before this is called done end-to-end.
3. **Low-severity findings left unfixed** (from Phase 4.4, your call): a slug containing a `.` is mis-split into slug + sub-path; non-string `title`/`platform`/`date` on a malformed-but-citable record pass through into fields typed `string`; `SOURCES_BLOCK_RE` is stricter than the sibling regexes in `parse-json.ts` and `eval-query-answer.ts`, so a `**Sources:**` heading is silently a no-op; unresolved duplicate publication entries are deduped, which the code comment doesn't describe. None affects the live profile.
4. **Consider validating `slug` and `title` at `upsert_publication`.** Two of the three defects fixed in this branch (title floor, slug grammar) exist because `src/routes/mcp.ts:30` accepts a bare `z.string()`. Constraining at the write boundary would let the read boundary relax.

## Inputs for /retro

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"A negative assertion ('output contains no X') is only meaningful on a surface that can produce X. Before writing one, confirm the surface under test emits X in any case at all — if it never does, the assertion is vacuous and the real guard lives elsewhere. Verify by deleting the guard and re-running: a test that stays green was not testing it."*
  **Triggered by:** AC-FN-3 — asserted "no URL" against the `sources` array, which carries no URL for any input. Deleting the actual guard in the prose surface left 46/46 green.

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"When a suite guards a defect class rather than a single case, mutation-test it: revert or corrupt the implementation and confirm the intended test fails. Do this at authoring time, not only when a reviewer asks. `assert.ok(x.includes(...))` and `startsWith` are the usual survivors — prefer exact equality unless the extra freedom is deliberate."*
  **Triggered by:** the Phase 4.4 reviewer found five surviving mutations by doing this; each corresponded to an `includes`/`startsWith` assertion or an untested surface.

- **Route:** `/backend-architect` → `~/.claude/commands/backend-architect.md`
  **Draft principle:** *"When resolving an identifier a model produced (an index, a name, a path) against a collection, resolve against the exact collection the model was shown — never a filtered, sorted, or deduped copy. If you must filter, validate the resolved record after lookup rather than filtering before it. Silent index-shifting turns a safety filter into a wrong-answer generator."*
  **Triggered by:** `citableOnly()` filtered before indexing, so one malformed row made every subsequent index cite a neighbouring publication — and the code comment claimed the filtering was what made indices line up.

- **Route:** `/backend-architect` → `~/.claude/commands/backend-architect.md`
  **Draft principle:** *"A containment test (`haystack.includes(needle)`) where the needle is unvalidated stored data needs a length floor and word boundaries before it can decide anything. A two-character title matches inside ordinary words. Ask what the shortest legal value is at the write boundary, not what the current data happens to look like."*
  **Triggered by:** title matching against `z.string()`-validated titles; both Phase 4.4 reviewers found it independently.

- **Route:** cross-cutting → `~/.claude/commands/agentic-workflow.md` (or the AC pattern catalog)
  **Draft addition:** *"A parked feature's unblock conditions are hypotheses about a codebase that keeps moving. Before reviving a parked branch, re-verify each condition against current `main` rather than trusting the park note — the blocker may be gone, already satisfied, or never have been what it said."*
  **Triggered by:** all three of #177's stated unblock conditions had changed. Publications had reached the prompt since chunk 1 (the park note's premise that injection was pending was never accurate), the compensating prompt strengthening had landed independently, and a publication had been seeded. Reviving the branch as written would have shipped a no-op injection plus the exact prompt edit that caused the park.

- **Route:** cross-cutting → `~/.claude/commands/agentic-workflow.md`
  **Draft addition:** *"When Phase 3 or 4.4 shows an AC's evidence cell claimed more than it proved, correct the cell rather than quietly upgrading the test to match. The human reads those cells as the audit trail; a cell silently repaired to look like it was always right destroys their value as a record of what was actually verified when."*
  **Triggered by:** two QC cells in this feature's ACs (AC-FN-9's anchoring claim, AC-FN-14's test credit) asserted evidence that did not hold. Both were rewritten to state what was true, with the correction visible.
