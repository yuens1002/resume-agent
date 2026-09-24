# Plan — align generated résumés with r/EngineeringResumes conventions

**Branch:** `feat/resume-wiki-format` (plan); implementation on its own branch once the open questions are answered
**Status:** planned, not started. No implementation has landed.
**Scope:** `/resume` generation (prompt, post-processing, rubric) and profile-authoring guidance. Rendering is out of scope (see Non-goals).
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

1. Generated content fits a one-page content budget: bounded summary, bullets, projects and skill rows.
2. Every emitted bullet opens with a past-tense action verb and carries no trailing period, `&`, or slash between alternatives.
3. Skills are emitted as categorized rows of concrete tools.
4. The rubric rewards STAR/XYZ-shaped bullets (accomplished [X], as measured by [Y], by doing [Z]).
5. Self-employment bullets and Projects don't restate the same work.
6. Profile authors have guidance for writing bullets the generator can use well.

## Non-goals

- **Physical page fit.** This repo emits structured content. Fonts, margins, header and layout belong to each consumer, so page count is theirs to verify. This plan sets a content budget only.
- **Rendering.** Consumer presentation (including header contents) is out of scope; see "Notes for consumers".
- **Generating metrics.** No metric may be generated, estimated or placeholdered that the profile doesn't ground. A bullet without a real metric stays without one.
- **Editing any fork's profile content.** Each fork curates its own profile; this plan ships guidance only.

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

1. `src/lib/resume-format.ts` (new): `normalizeResumeFormat(resume)` plus exported budget constants:
   - strip trailing periods; change `" & "` to `"and"`
   - cap the summary at 2 sentences
   - cap bullets at 4 for the most recent role and 2 for older roles
   - cap Projects at 2 entries × 3 highlights, and Skills at 4 rows
   - drop self-employment bullets that restate a featured project, keeping at least one
2. `src/routes/resume.ts`: prompt updates:
   - summary at most 2 sentences, JD title first, no abstract descriptors
   - categorized skills of concrete tools, and a response example with `{ category, items }`
   - past-tense opening verb, no slashes between alternatives (`CI/CD` and similar names exempt)
   - 1–2 JD-relevant projects
   - may rewrite a weak opening verb from the pool; may never add a metric
   - wire `normalizeResumeFormat` in after `stripBannedPhrases`
3. `src/lib/score-resume.ts`: add the weak verbs to `BANNED_PHRASES`; add the XYZ rule.
4. `src/lib/strip-banned.ts`: a replacement for each new banned phrase.
5. `docs/resume-pipeline-v2.md`: update the rules table. It currently describes 6 scored rules, but only 5 have been scored since Rule 5 was removed in #80.
6. Profile-authoring guidance for XYZ bullets, placed where profile authors already look (location decided at implementation).

## Decisions locked from planning session

1. **Summary kept, capped at 2 sentences.** The wiki allows a summary when an exception applies. Rule 1 (JD title first) stays because title matching serves ATS parsing.
2. **One-page content budget via deterministic caps**, not prompt guidance alone. Caps are predictable and testable; prompts drift. Physical page fit stays with consumers (Non-goals).
3. **Employment describes outcomes, Projects carry technical depth.** A product featured under Projects is not restated in self-employment bullets, so the budget isn't spent twice on the same work.
4. **Truthfulness over polish.** No metric is generated that the profile doesn't ground. A résumé making claims its owner can't back is worse than a plainer one.
5. **This repo owns the output contract, not presentation.** Rendering guidance is a note for consumers, not a requirement here.

## Acceptance criteria

Criteria marked *(pending OQ-n)* depend on an open question and are finalized when it's answered.

**Behavior: post-processing**
- AC-1: No emitted bullet or highlight ends with a period.
- AC-2: `" & "` in a bullet is emitted as `" and "`; `&` inside a name (e.g. "R&D") is untouched.
- AC-3: The summary has at most 2 sentences; periods inside tokens such as `Node.js` don't count as sentence ends.
- AC-4: The most recent role has at most 4 bullets and every other role at most 2; roles are ordered most recent first.
- AC-5: At most 2 projects with at most 3 highlights each, and at most 4 skill rows.
- AC-6: A self-employment bullet naming a featured project is dropped, but the entry always keeps at least one bullet.
- AC-7: Budget values are exported constants; the tests read them rather than repeating the numbers.

**Behavior: rubric**
- AC-8: Each new weak-verb phrase in `BANNED_PHRASES` triggers the Rule 4 veto, and `stripBannedPhrases` replaces it with a grammatical substitute.
- AC-9: The XYZ rule scores a bullet as XYZ-shaped only when it opens with a past-tense verb, contains a measurable outcome, and names the method. *(pending OQ-2, OQ-3)*
- AC-10: `PASS_THRESHOLD` is set per the answer to OQ-1, and `docs/resume-pipeline-v2.md` states the new total. *(pending OQ-1)*

**Schema**
- AC-11: The prompt's response example emits `skills` as `{ category, items }` rows, and the rubric's skill rules accept that shape (already true today, pinned by test).

**Truthfulness (regression)**
- AC-12: Post-processing never adds characters that form a number; a fixture bullet without a metric has none after processing.

**Docs**
- AC-13: `docs/resume-pipeline-v2.md` matches the shipped rules, and the authoring guidance exists. *(manual review)*

**Verification**
- AC-14: Before/after résumés generated for 2–3 JDs of different role types; rubric scores compared and recorded. *(smoke-only, needs live generation)*

## Rollback

`git revert <implementation merge commit>`. Every change is code and prompt text in this repo; there are no migrations or data changes. The response shape doesn't change (`skills` is already typed as categorized rows), so consumers need no coordinated rollback.

## What this unlocks

- Consumers get one-page-oriented, wiki-conformant content without their own trimming logic.
- The STAR/XYZ rule gives the dual-generation picker a quality signal beyond "contains a number".
- Profile-authoring guidance lets any fork improve its output by improving its source bullets.

## Notes for consumers

`skills` is emitted as categorized `{ category, items }` rows. A consumer rendering the résumé should print one row per category with its items comma-separated. Middle dots, pipes and slashes are what the wiki warns against. Header contents are the consumer's call; the wiki recommends leaving out a LinkedIn URL. Page fit depends on the consumer's layout.

## Open questions

- **OQ-1, pass threshold.** The pass mark is 4.0 of 5 scored points today. Adding the XYZ rule makes it 4.0 of 6, a lower bar. Keep 4.0, or raise it to about 4.8 to hold the current bar?
- **OQ-2, XYZ strictness.** Scored rule (recommended) or hard veto like Rule 4?
- **OQ-3, scope.** Should the XYZ rule and the authoring guidance cover employment bullets only, or project highlights too?
