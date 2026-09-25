# /review report — resume-wiki-format (plan only)

**Branch:** `feat/resume-wiki-format`
**Reviewed against:** `origin/main` @ `354d131` (merge base verified equal before review)
**Scope:** `docs/plans/resume-wiki-format/plan.md` and issue #298. Docs-only. The plan defines AC-1 to AC-14, but no implementation or tests exist for them yet, so Steps 1–2 (deliverables ↔ code, ACs ↔ tests) have nothing to check until implementation lands.

## Verdict

Minor: two Public-Repo Rule findings introduced by the first draft, both fixed in this change. No Kind A leaks. Clear to commit.

## Docs drift

### Claim accuracy (3a / 3c)
Each factual claim in the plan was checked against the code at the reviewed SHA:
- "5 scored rules": `scoreResume` returns 5 rules; `tests/score-resume.test.ts` pins `rules.length === 5`.
- "Rule 5 removed in #80": `scoreRule5` was deleted in `b905974` (#80).
- "`{ category, items }` already the typed shape": `Skill` in `src/types.ts`.
- `BANNED_PHRASES`, `stripBannedPhrases`, and the prompt's rules 8/9 exist as described.
- `docs/resume-pipeline-v2.md` describes "6 Scored" rules.
- "≈4.8 holds the current bar": 4.0 / 5 = 0.8; 0.8 × 6 = 4.8.

None stale or overstated.

### Internal consistency (3e), re-run after the last fix
- Two references still used the retracted "content pass" framing (the problem table, open question 3). Reworded to "profile-authoring guidance" / "Guidance scope".
- Anchors ("Notes for consumers") resolve. Counts agree. Clean.

## Docs hygiene / public-voice audit

Checked under the repo's own Public-Repo Rule (`CONTRIBUTING.md`).

| Finding | Kind | Location | Introduced or pre-existing | Resolution |
|---|---|---|---|---|
| Plan described one downstream consumer's renderer (its file formats, header choice, per-repo shipping) | B | first draft, Phase 1 and Phase 4 | introduced | Replaced with a generic "Notes for consumers" on the output contract |
| Plan described the maintainer's own review-and-approve workflow for their profile content | C | first draft, Phase 3 | introduced | Reframed as profile-authoring guidance any fork can apply |

Mechanical scan: plan and issue #298 contain no private repo/org names, denylist terms, personal names, emails, or local paths.

## Round-1 addendum (Copilot review on PR #299)

Two findings, both valid, both fixed:
- **Overclaim.** "One page, enforced by deterministic caps" promised a physical outcome this repo can't control, since layout belongs to consumers. Reworded to a one-page *content budget*; page fit is now an explicit non-goal.
- **Missing required structure.** The plan lacked CONTRIBUTING's required plan sections (Context through What this unlocks, with `AC-N` criteria) and a `ROADMAP.md` entry. The plan was restructured to that template with 14 ACs (2 marked pending on open questions), and the ROADMAP gained a Next entry.

3e re-run after these fixes: the CHANGELOG entry's "phases" and "one page enforced" wording and this report's dead "Phase 2" anchor were updated to match. Clean.

## Round-2 addendum (Copilot review on PR #299)

Four findings, all valid, all fixed:
- Goal 2 promised past-tense openings as an invariant, but only periods and `&` are enforced deterministically. The goals now separate guaranteed from required-and-rewarded.
- The caps don't bound every field. Goal 1 is narrowed, and unbounded role count and text length are a stated non-goal.
- Rollback claimed no consumer coordination. Wrong: switching the prompt changes the wire format from strings to objects. Rollback and the consumer note now require consumers to accept both shapes first; AC-11 pins both.
- This report's scope line said no ACs exist; it now says they're defined but not yet implemented or tested.

3e re-run after these fixes: goal numbering (now 1–7) isn't referenced elsewhere; the CHANGELOG entry doesn't restate the changed claims. Clean.

## Inputs for /retro

- **Route:** cross-cutting → planning practice
  **Draft principle:** *"When a feature spans this public repo and a private consumer, the public plan describes only this repo's contract and a generic consumer note. The consumer's own implementation plan lives in the consumer's repo."*
  **Triggered by:** first-draft Phase 1.

- **Route:** cross-cutting → `/review` Step 3 (repo conventions)
  **Draft principle:** *"For a new `docs/plans/` file, check it against the repo's own required plan structure (CONTRIBUTING's section list, `AC-N` format, ROADMAP entry) before hygiene. A hygiene-only pass misses a structurally incomplete plan."*
  **Triggered by:** round-1 finding on missing required sections.

---

# /review report — implementation

**Branch:** `feat/resume-wiki-format-impl`, reviewed at `02ab421` against `origin/main` `68babbe` (merge base verified equal).

## Verdict

Clear for owner review. Every AC passes (Agent and QC columns in `ACs.md`). Verification, `/ocr-review` and this pass each found real defects in work the previous layer had passed, and all were fixed before this report. Three AC Pass cells were amended with the reason recorded in the cell.

## Deliverables ↔ code

| Deliverable | Implementation | Docs touched? |
|---|---|---|
| D1 post-processing | `src/lib/resume-format.ts` | Y (`docs/resume-pipeline-v2.md`) |
| D2 rubric | `src/lib/score-resume.ts` | Y |
| D3 replacements | `src/lib/strip-banned.ts` | Y |
| D4 prompt + wiring | `src/lib/generate-resume.ts`, `src/routes/resume.ts` | Y |
| D5 tests | `tests/resume-format.test.ts`, `tests/score-resume.test.ts`, `tests/strip-banned.test.ts`, `package.json` | n/a |
| D6 docs | `docs/resume-pipeline-v2.md`, `README.md` | Y |
| D7 generation core | `src/lib/generate-resume.ts` | Y |
| D8 eval | `scripts/eval/run-resume-eval.ts`, `scripts/eval/resume-eval-cases.ts`, `package.json` | Y |
| D9 pinned roles | `src/lib/resume-format.ts`, `src/lib/generate-resume.ts`, `src/lib/score-resume.ts`, `src/types.ts` | Y |

Changes outside the deliverables list: the README's rubric sentence (it already named a rule removed in #80; fixed alongside D6). The sync-side guard for pinned roles shipped separately in #301, ahead of this branch.

## Plan and AC changes during implementation

- **AC-FN-8 (STAR/XYZ detector).** The first live eval showed the detector rejecting clear outcomes because it required a method word, and accepting any digit as a result. Amended with owner approval: a past-tense verb plus a real result, numeric or an outcome clause.
- **AC-FN-14 (pinned roles).** Three rounds of verification probes found that reconciling model output with pinned roles duplicated or merged roles. Redesigned so pinned roles always come from the profile: the model sees them only as context, and post-processing inserts them.
- **AC-FN-1.** Scoped to non-pinned bullets, since pinned bullets are verbatim by AC-FN-14.
- **Banned phrases.** `/ocr-review` showed "functions as" and "responsible for" rewrote ordinary prose ("Lambda functions as microservices"). Both were dropped; the STAR/XYZ rule already penalizes them as openers.
- **Commit schedule.** D1–D9 landed as one feature commit plus fix commits, noted in the plan.

## Docs drift

- **Stale:** the plan's status line, and the pipeline doc's pre-existing Rule 5 and "4.0 / 6" claims. Both fixed.
- **Overclaims fixed:** plan Goal 2 (bullet grammar is guaranteed only for non-pinned bullets), and "post-processing never adds content" in the pipeline doc and code comment (it adds pinned roles, from the profile).
- **Rule names:** the pipeline doc's rules table uses the exact `name` strings `scoreResume` returns.
- **Internal consistency,** re-run after the last fix commit: the banned-phrase list reads the same in the pipeline doc, the ACs and the code. Clean.

## Docs hygiene / public-voice audit

- No private repo, org or person, and no personal data, in the diff or commit messages.
- Test fixtures use fictional product names and roles.
- Eval JDs are synthetic.
- The downstream renderer is referenced generically.

## Consumers

- **`resume-agent-web`:** already accepts both skill shapes.
- **The private renderer:** shipped its update ahead of this branch.
- **`scripts/sync.ts`:** its banned-phrase gate widens with the newly banned phrases, as the plan intends.

## Inputs for /retro

- **Route:** cross-cutting, the working method for scripted edits.
  **Draft principle:** *"Don't write regex or escape-bearing code through a Python heredoc: `\b`, `\n` and `\d` were silently turned into control characters or real newlines five times in this feature. Use the Edit tool for any line containing escapes, and grep for `\x08` after scripted edits."*
  **Triggered by:** repeated corrupted regexes and strings, each caught only by a later test or read.
- **Route:** `/test-engineer`.
  **Draft principle:** *"Check what `tsc -p .` actually covers before citing it as evidence. Here `tsconfig.json` includes only `src`, so the eval scripts were never typechecked until checked explicitly."*
  **Triggered by:** a mangled string in the eval runner that "tsc clean" didn't catch.
- **Route:** `/backend-architect`.
  **Draft principle:** *"When a pipeline must honor owner-fixed content alongside model output, make the owner's source the only source (context-only for the model, inserted after) instead of reconciling the model's copy. Reconciliation needs identity rules that fail in ways probes keep finding."*
  **Triggered by:** three probe rounds on pinned-role matching before the redesign.
