# /review report — resume-wiki-format (plan only)

**Branch:** `feat/resume-wiki-format`
**Reviewed against:** `origin/main` @ `354d131` (merge base verified equal before review)
**Scope:** `docs/plans/resume-wiki-format/plan.md` and issue #298. Docs-only; no code, tests or ACs exist yet, so Steps 1–2 (deliverables ↔ code, ACs ↔ tests) do not apply.

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
- Anchors ("Notes for consumers", "Phase 2") resolve. Counts agree. Clean.

## Docs hygiene / public-voice audit

Checked under the repo's own Public-Repo Rule (`CONTRIBUTING.md`).

| Finding | Kind | Location | Introduced or pre-existing | Resolution |
|---|---|---|---|---|
| Plan described one downstream consumer's renderer (its file formats, header choice, per-repo shipping) | B | first draft, Phase 1 and Phase 4 | introduced | Replaced with a generic "Notes for consumers" on the output contract |
| Plan described the maintainer's own review-and-approve workflow for their profile content | C | first draft, Phase 3 | introduced | Reframed as profile-authoring guidance any fork can apply |

Mechanical scan: plan and issue #298 contain no private repo/org names, denylist terms, personal names, emails, or local paths.

## Inputs for /retro

- **Route:** cross-cutting → planning practice
  **Draft principle:** *"When a feature spans this public repo and a private consumer, the public plan describes only this repo's contract and a generic consumer note. The consumer's own implementation plan lives in the consumer's repo."*
  **Triggered by:** first-draft Phase 1.
