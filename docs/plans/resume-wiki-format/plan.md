# Plan — align generated résumés with r/EngineeringResumes conventions

**Branch:** `feat/resume-wiki-format-impl`
**Status:** approved 2026-09-25; implemented and verified (see `ACs.md` and `review.md`), awaiting owner review.
**Acceptance criteria:** `ACs.md` · **Review report:** `review.md`
**Scope:** `/resume` generation: prompt, post-processing, rubric. Rendering and profile content are out of scope (see Non-goals).
**Issue:** #298
**Reference:** [r/EngineeringResumes wiki](https://old.reddit.com/r/EngineeringResumes/wiki/index)

## Context

`POST /resume` generates two tailored résumés in parallel, scores both with a deterministic rubric (`src/lib/score-resume.ts`), strips banned phrases (`src/lib/strip-banned.ts`), and returns the winner as structured JSON. Measured against the r/EngineeringResumes wiki, the output has gaps:

| Problem | Where it originates |
|---|---|
| Content well beyond a one-page budget | No length budget anywhere in the pipeline |
| Dense, abstract multi-sentence summary | Prompt Rule 1 asks for a summary with no length bound |
| Skills as one flat, uncategorized list mixing tools and concepts | Prompt Rule 7 and the response example ask for a flat list, although `Skill` in `src/types.ts` is already `{ category, items }` |
| Trailing periods, `&`, slashes in bullets | Profile bullet pool; no rule or post-processing |
| Weak, passive, present-tense or verbless openings ("utilized", "participated", "functions as") | Profile bullet pool; `BANNED_PHRASES` too narrow |
| Bullets describe duties rather than results | Profile bullet pool; Rule 3 checks for a number, not the STAR/XYZ shape |
| Self-employment bullets restate products already under Projects | Prompt rules 8 and 9 route the same products to both sections |

## Goals

1. Generated content is bounded toward a one-page budget: the summary, bullets per role, projects, highlights and skill rows are capped. This narrows the usual overflow; it does not bound every field (see Non-goals).
2. **Guaranteed** by deterministic post-processing: no emitted project highlight or non-pinned employment bullet ends with a period or contains `" & "`. Pinned bullets are the owner's text, emitted verbatim.
3. **Required and rewarded, not guaranteed:** past-tense opening verbs and no slashes between alternatives. The prompt requires them and the rubric scores them, but the winning candidate still ships when it fails the rubric, so they aren't guarantees.
4. Skills are emitted as categorized rows of concrete tools.
5. The rubric rewards STAR/XYZ-shaped bullets (accomplished [X], as measured by [Y], by doing [Z]).
6. Self-employment bullets and Projects don't restate the same work.

## Non-goals

- **Physical page fit.** This repo emits structured content. Fonts, margins, header and layout belong to each consumer, so page count is theirs to verify. This plan sets a content budget only.
- **Bounding every field.** The number of employment entries and the length of individual bullets, descriptions and education lines are not capped. Truncating text mid-sentence would damage meaning, and the role count is left to the prompt's relevance selection.
- **Rendering.** Consumer presentation (including header contents) is out of scope; see "Notes for consumers".
- **Generating metrics.** No metric may be generated, estimated or placeholdered that the profile doesn't ground. A bullet without a real metric stays without one.
- **Profile content and authoring guidance.** Deferred by the owner (2026-09-24). The generator only selects and lightly adapts profile bullets, so output quality still depends on each fork's source bullets; that work is tracked separately.

## Architecture

```
POST /resume
  ├─ build prompt ──────────────── (changed: summary bound, categorized skills,
  │                                  bullet grammar, projects 1–2, dedupe rule)
  ├─ generateOne() ×2 (parallel)
  ├─ stripBannedPhrases()   ─────── (changed: weak-verb replacements)
  ├─ normalizeResumeFormat() ────── (new: deterministic format + content budget)
  ├─ scoreResume() ×2 ──────────── (changed: weak verbs in Rule 4, new XYZ rule)
  └─ pick winner → respond
```

The new post-processing step runs before scoring, beside the existing banned-phrase strip, so the rubric scores what actually ships.

## Implementation shape

| ID | Deliverable | Kind | Owning role |
|----|-------------|------|-------------|
| D1 | `src/lib/resume-format.ts`: `normalizeResumeFormat` + exported `RESUME_BUDGET`. Strips trailing periods, spells out a standalone `&`, caps the summary at 2 sentences, orders roles most recent first, caps bullets (4 for the most recent role, 2 for others), projects (2 × 3 highlights) and categorized skill rows (4), and drops self-employment bullets that restate a featured project while keeping at least one | lib (pure function) | `/backend-architect` |
| D2 | `src/lib/score-resume.ts`: weak verbs added to `BANNED_PHRASES`; new STAR/XYZ rule over employment bullets, listed second; `PASS_THRESHOLD` raised to 4.8 | lib (scorer) | `/backend-architect` |
| D3 | `src/lib/strip-banned.ts`: a grammatical replacement for each new banned phrase | lib | `/backend-architect` |
| D4 | `src/lib/generate-resume.ts` (prompt, moved from `src/routes/resume.ts` by D7) and `src/routes/resume.ts`: prompt updates (summary bound, STAR/XYZ and bullet grammar, categorized skills and response example, verb-rewrite permission with no added metrics, role bullet budget, 1–2 projects, self-employment dedupe), and `normalizeResumeFormat` wired after `stripBannedPhrases`, before scoring | endpoint | `/backend-architect` |
| D5 | `tests/resume-format.test.ts` plus updates to `tests/score-resume.test.ts`, registered in `test:unit` | test | `/test-engineer` |
| D6 | `docs/resume-pipeline-v2.md`: rules table and pass threshold match the shipped rubric | docs | `/backend-architect` |
| D7 | `src/lib/generate-resume.ts`: the dual-generation, post-processing, scoring and winner selection extracted from the `/resume` handler into a callable core, so the route and the eval run the same code. Route behavior and response shape unchanged | lib (refactor) | `/backend-architect` |
| D8 | `scripts/eval/resume-eval-cases.ts` + `scripts/eval/run-resume-eval.ts` + `npm run eval:resume`: synthetic JDs across different role types, run through `generateResume`, with deterministic checks per output (format and budget invariants, categorized skills, STAR/XYZ share of employment bullets, no banned phrases, and every number in the résumé present somewhere in the profile). On demand only, not in `test:unit` or the weekly workflow | eval | `/test-engineer` |

| D9 | Pinned employment bullets: an employment entry with `pinned: true` in the profile always comes from the profile, never the model. The model sees pinned roles only as context (a separate `pinned_employment` key) and is told not to output them; `normalizeResumeFormat` drops any model copy and inserts each pinned role once with its company, title, dates and bullets verbatim, exempt from caps and dedupe. The model can't mark a role pinned, and the STAR/XYZ rule skips pinned entries | lib + endpoint | `/backend-architect` |

**In-repo consumer.** `scripts/sync.ts` rejects LLM-proposed project highlights containing any `BANNED_PHRASES` entry. Adding the weak verbs (D2) widens that gate, so sync will also reject proposals using them. This is intended: it keeps weak verbs out of the profile.

**Consumers of `/resume`.**
- `resume-agent-web` (`src/lib/resumeDoc.ts`) already accepts both skill shapes, flattening categorized rows into chips, so it needs no change. Separately and pre-existing, it labels the rubric total as out of 10; this work makes the maximum 6. That label is out of scope here.
- A private downstream document renderer must accept categorized `{ category, items }` rows before D4 ships (see Rollback). That change lives in its own repo.

### Commit schedule
1. `docs(plans): update resume-wiki-format plan and add ACs`
2. `refactor(resume): extract generateResume core` (D7)
3. `feat(resume): format and content budget, STAR/XYZ rule, prompt updates` (D1–D6)
4. `feat(resume): pinned employment bullets` (D9)
5. `feat(eval): add on-demand resume eval` (D8)
6. `chore: verification` (ACs Agent/QC columns, review report)

*As shipped:* D1–D9 landed in one feature commit rather than the separate refactor, feature, pinned and eval commits above (the files were interleaved in the working tree), followed by verification fix commits. The sync-side guard for pinned roles shipped separately and first, in #301, because the next nightly run would otherwise have overwritten a live pinned entry.

## Decisions locked from planning session

1. **Summary kept, capped at 2 sentences.** The wiki allows a summary when an exception applies. Rule 1 (JD title first) stays because title matching serves ATS parsing.
2. **One-page content budget via deterministic caps**, not prompt guidance alone. Caps are predictable and testable; prompts drift. Physical page fit stays with consumers (Non-goals).
3. **Employment describes outcomes, Projects carry technical depth.** A product featured under Projects is not restated in self-employment bullets, so the budget isn't spent twice on the same work.
4. **Truthfulness over polish.** No metric is generated that the profile doesn't ground. A résumé making claims its owner can't back is worse than a plainer one.
5. **This repo owns the output contract, not presentation.** Rendering guidance is a note for consumers, not a requirement here.
6. **Pass threshold raised to 4.8** (owner, 2026-09-24). A sixth scored rule at the old 4.0 would lower the bar; 4.8 of 6 keeps the 4.0-of-5 ratio.
7. **STAR/XYZ is a scored rule, listed second** (owner, 2026-09-24), right after the summary-title rule. It counts toward the pass mark but doesn't veto on its own. It takes the vacant Rule 5 id, so existing rule ids stay stable.
8. **STAR/XYZ covers employment bullets only** (owner, 2026-09-24). Project highlights stay under Rule 3's metric check.
9. **A résumé eval runs on demand only** (owner, 2026-09-24): `npm run eval:resume`, not part of the weekly gate. Its JDs are synthetic, so no real employer text enters the public repo.
10. **Pinned bullets for owner-curated roles** (owner, 2026-09-25). A role can carry a fixed list of bullets, written by the owner to state common threads across work, instead of a pool the generator picks from. The pipeline passes them through unchanged; the STAR/XYZ rule scores only generator-selected bullets.

## Acceptance criteria

See `ACs.md` (with Plan ref and Role columns, and Agent, QC and Reviewer columns filled during verification).

## Rollback

`git revert <implementation merge commit>`. Every change is code and prompt text in this repo; there are no migrations or data changes.

The wire format does change: `Skill` is already typed as `{ category, items }`, but `parseJSON` only casts model output and today's prompt yields flat strings, so consumers currently receive strings. Switching the prompt makes them receive objects. Consumers must therefore accept **both** shapes before the generation change ships. Once they do, a revert back to flat strings is safe with no coordinated change.

## What this unlocks

- Consumers get one-page-oriented, wiki-conformant content without their own trimming logic.
- The STAR/XYZ rule gives the dual-generation picker a quality signal beyond "contains a number".
- Profile-authoring guidance lets any fork improve its output by improving its source bullets.

## Notes for consumers

`skills` changes from flat strings to categorized `{ category, items }` rows when this ships. Accept both shapes first (see Rollback). A consumer rendering the résumé should print one row per category with its items comma-separated. Middle dots, pipes and slashes are what the wiki warns against. Header contents are the consumer's call; the wiki recommends leaving out a LinkedIn URL. Page fit depends on the consumer's layout.

## Open questions

None. All three were answered on 2026-09-24 and are recorded as decisions 6–8.
