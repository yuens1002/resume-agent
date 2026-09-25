# Résumé wiki alignment: acceptance criteria

Plan: `docs/plans/resume-wiki-format/plan.md` · Branch: `feat/resume-wiki-format-impl` · Issue: #298

Pass conditions are **invariants**, not equality against a literal. Tests read budget values from `RESUME_BUDGET` and the threshold from `PASS_THRESHOLD` rather than repeating the numbers. Agent is filled by the verification sub-agent, QC by the main thread, Reviewer by the owner.

| ID | Plan ref | Role | Acceptance criterion | Pass (invariant) | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-1 | D1 | backend-architect | Bullet grammar is enforced | No emitted employment bullet or project highlight ends with a period; a standalone `&` between words becomes "and"; an `&` inside a token (e.g. "R&D") is unchanged | | | |
| AC-FN-2 | D1 | backend-architect | Summary is bounded | The emitted summary has at most `RESUME_BUDGET.summarySentences` sentences; a period inside a token (e.g. "Node.js") is not treated as a sentence end | | | |
| AC-FN-3 | D1 | backend-architect | Roles are ordered and budgeted | Emitted roles are in descending `start_date` order; the first has at most `mostRecentRoleBullets` bullets and every other role at most `otherRoleBullets` | | | |
| AC-FN-4 | D1 | backend-architect | Projects and skills are budgeted | At most `projects` projects, each with at most `projectHighlights` highlights; categorized skills capped at `skillRows` rows; a flat string skills list passes through unchanged | | | |
| AC-FN-5 | D1 | backend-architect | Self-employment doesn't restate Projects | A self-employment bullet that names a featured project is dropped; a self-employment entry never ends up with zero bullets | | | |
| AC-FN-6 | D1 | backend-architect | Post-processing never adds a metric | For every bullet, the digits in the output are a subset of the digits in the input: post-processing only removes or rewords | | | |
| AC-FN-7 | D2, D3 | backend-architect | Weak verbs are vetoed and replaced | Each newly banned phrase triggers the Rule 4 veto when present, and after `stripBannedPhrases` no banned phrase remains and no bullet is emptied by the replacement | | | |
| AC-FN-8 | D2 | backend-architect | STAR/XYZ rule scores shape, on employment bullets only | A bullet counts only when it opens with a past-tense verb, states a result, and names the method; changing project highlights never changes the rule's score; the rule is listed second in `scoreResume` output | | | |
| AC-FN-9 | D2 | backend-architect | Pass bar is preserved | `PASS_THRESHOLD` divided by the number of scored rules equals the previous 4.0 / 5 ratio | | | |
| AC-FN-10 | D4 | backend-architect | Scoring sees the shipped output | In `/resume`, each candidate goes through `stripBannedPhrases` then `normalizeResumeFormat` before `scoreResume`, and the response body is the post-processed winner | | | |
| AC-FN-11 | D4 | backend-architect | Prompt states the new rules | The system prompt instructs: summary of at most 2 sentences; STAR/XYZ bullets with bullet grammar; never invent or estimate a metric; categorized skills with a `{ category, items }` response example; role bullet budget; 1–2 projects; no restating featured projects in self-employment | | | |
| AC-FN-12 | D7 | backend-architect | Route and eval share one generation core | The `/resume` handler delegates generation, post-processing, scoring and winner selection to `generateResume`; the SSE response body keeps the same fields as before the refactor | | | |
| AC-FN-13 | D2 | backend-architect | Sync's banned-phrase gate widens as intended | `scripts/sync.ts` still reads `BANNED_PHRASES` from the rubric, so a proposed highlight containing any newly banned phrase is rejected | | | |
| AC-FN-14 | D9 | backend-architect | Pinned bullets pass through verbatim | For an employment entry with `pinned: true`, the emitted bullets equal the profile's bullets exactly and in order, even when the model returned different text, and are exempt from the bullet caps and the self-employment dedupe | | | |
| AC-FN-15 | D9 | backend-architect | STAR/XYZ scores only generator-selected bullets | Changing the bullets of a pinned entry never changes the STAR/XYZ rule's score | | | |
| AC-EVAL-1 | D8 | test-engineer | Eval cases span role types and stay synthetic | The cases cover at least 3 distinct role types, and no JD is copied from a real employer posting | | | |
| AC-EVAL-2 | D8 | test-engineer | Eval checks the shipped invariants | For each generated résumé the runner checks format and budget invariants, categorized skills, STAR/XYZ share, absence of banned phrases, and that every number in the output appears in the profile; any violated check fails the case and names it | | | |
| AC-EVAL-3 | D8 | test-engineer | Eval is on demand only | `npm run eval:resume` exists; the runner is not in `test:unit` and not in any workflow under `.github/workflows/` | | | |
| AC-TST-1 | D5 | test-engineer | New tests run in the unit suite | The new and updated test files are registered in `test:unit` and execute without network access or `.env.local` | | | |
| AC-DOC-1 | D6 | backend-architect | Pipeline doc matches the rubric | `docs/resume-pipeline-v2.md` lists the rules `scoreResume` actually returns (ids and names) and the current pass threshold | | | |
| AC-SMK-1 | D4, D8 | backend-architect | Live output reflects the changes *(smoke-only: needs live generation)* | `npm run eval:resume` runs against the live profile on this branch; every case passes or its failure is explained in the review report | | | |
| AC-REG-1 | — | test-engineer | No regression | `npm run build` passes and `test:unit` passes | | | |
| AC-PUB-1 | — | backend-architect | Public-repo hygiene | No file, commit message or PR text on this branch names a private repo, org or person, or contains personal data | | | |
