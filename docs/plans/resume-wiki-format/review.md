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
