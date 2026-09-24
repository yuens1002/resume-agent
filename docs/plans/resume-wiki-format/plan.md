# Plan — align generated résumés with r/EngineeringResumes conventions (#298)

Status: **planned, not started.** No implementation has landed; open questions below need answers first.

Reference: [r/EngineeringResumes wiki](https://old.reddit.com/r/EngineeringResumes/wiki/index)

## Decisions (settled)

| Topic | Decision |
|---|---|
| Summary | Keep, capped at 2 sentences, JD title first (Rule 1 stays). No abstract descriptors. |
| Length | One page, enforced by deterministic caps in code, not by prompt guidance alone. |
| Self-employment vs Projects | Employment bullets describe outcomes and delivery scope. A product featured under Projects is not restated there. Projects (1–2, chosen per JD) carry the technical depth. |
| Truthfulness | No metric may be generated or added that isn't grounded in the profile. A bullet without a real metric stays without one; the generator never fills in placeholders or estimates. |
| Rendering | This repo owns the `/resume` output contract, not its presentation. Header contents and layout are each consumer's choice; see "Notes for consumers". |

## Where each problem lives

| Problem | Source | Fix location |
|---|---|---|
| Skills as a flat, uncategorized block | Prompt asks for a flat list | Prompt (categorized `{ category, items }` rows, already the typed shape in `src/types.ts`) |
| Trailing periods, `&` in bullets | Profile bullet pool + prompt | Deterministic post-processing before scoring |
| Weak/passive/verbless openings | Profile pool; banned list too narrow | Rubric banned list (with replacements) + prompt permission to rewrite an opening verb |
| Slashes between alternatives | No rule | Prompt rule; established names like `CI/CD` are exempt |
| Duties instead of results | Profile pool + no shape check | New scored STAR/XYZ rule + profile-authoring guidance (Phase 2) |
| Self-employment duplicates Projects | Prompt rules 8/9 route the same products to both | Prompt rule + deterministic dedupe |
| Runs past one page | No length budget | Deterministic caps |

## Phases

### 1. Generator structure
1. **Deterministic post-processing** (before scoring, beside `stripBannedPhrases`):
   - strip trailing periods and change `" & "` to `"and"`
   - cap the summary at 2 sentences
   - cap bullets at 4 for the most recent role and 2 for older roles
   - cap Projects at 2 entries × 3 highlights, and Skills at 4 rows
   - drop self-employment bullets that restate a featured project, keeping at least one
   - caps are data-driven constants, not scattered literals
2. **Prompt** (`src/routes/resume.ts`):
   - categorized skills of concrete tools only
   - past-tense opening verb, no slashes or trailing periods
   - 1–2 JD-relevant projects
   - may rewrite a weak opening verb from the pool; may not add metrics
3. **Rubric** (`src/lib/score-resume.ts`):
   - extend `BANNED_PHRASES` with weak verbs ("utilized", "participated in", "enhanced", "functions as", "responsible for"), each with a `stripBannedPhrases` replacement
   - add a scored STAR/XYZ rule: a bullet opens with a past-tense verb, states a measurable outcome, and names the method
4. **Docs:** update `docs/resume-pipeline-v2.md`. It currently describes 6 scored rules, but only 5 have been scored since Rule 5 was removed in #80.

### 2. Profile bullet quality (STAR/XYZ)
The generator selects and lightly adapts bullets from the profile; it does not invent them. So a profile whose bullets describe duties produces résumés that describe duties, whatever the prompt says.
- Document profile-authoring guidance: write each employment bullet in XYZ form (accomplished [X], as measured by [Y], by doing [Z]), with a past-tense opening verb, and record real metrics in the profile where they exist.
- Every fork curates its own profile content; the guidance is how a fork gets full value from the rubric.

### 3. Verify
- Generate before/after résumés for 2–3 JDs spanning different role types, and compare rubric scores.
- Confirm the capped output fits one page when rendered.

## Notes for consumers

`skills` is emitted as categorized `{ category, items }` rows. A consumer rendering the résumé should print one row per category with its items comma-separated. Middle dots, pipes and slashes are what the wiki warns against. Header contents are the consumer's call; the wiki recommends leaving out a LinkedIn URL.

## Open questions

1. **Pass threshold.** The pass mark is 4.0 of 5 scored points today. Adding the XYZ rule makes it 4.0 of 6, a lower bar. Keep 4.0, or raise it (≈4.8) to hold the current bar?
2. **XYZ strictness.** Scored rule (recommended) or hard veto like Rule 4?
3. **Guidance scope.** Should the Phase 2 authoring guidance and the XYZ rule cover employment bullets only, or project highlights too?
