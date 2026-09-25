# Resume Pipeline v2 — Dual-Gen + Rubric Scorer

## Problem

The v1 `/resume` endpoint produced a single LLM-generated resume per JD. Quality varied significantly between runs — the same prompt could yield a "Full-stack engineer" summary for a "Sr UX Engineer" role, miss key JD keywords, or produce generic bullets lacking real metrics. There was no way to detect or prevent these failures.

## Architecture

The generation core lives in `src/lib/generate-resume.ts` (`generateResume`), shared by the route and the on-demand eval. The route adds SSE framing, rubric-failure logging and contact/URL injection.

```
POST /resume  { job_description, framing_hints? }
  │
  ├─ Fetch candidate profile from OB1 Postgres (Supabase DB)
  │
  ├─ generateResume()                     src/lib/generate-resume.ts
  │    ├─ Build user message (profile + relevant thoughts + JD + framing hints)
  │    ├─ ┌─ generateOne() ─┐  (parallel, independent)
  │    │  └─ generateOne() ─┘
  │    ├─ For each candidate:
  │    │    stripBannedPhrases → normalizeResumeFormat → scoreResume
  │    └─ Candidates sorted best-first
  │
  ├─ If the winner doesn't pass the threshold:
  │    └─ Log RESUME_RUBRIC_FAILURE to OB1 thoughts (private)
  │
  └─ Return winner + _rubric metadata
```

## Post-processing: format and content budget

`normalizeResumeFormat` (`src/lib/resume-format.ts`) runs before scoring, so the rubric scores what ships. It removes or rewords the model's output and never invents content or a number; the only thing it adds is pinned roles, taken verbatim from the profile.

- Strips trailing periods from bullets and spells out a standalone `&` as "and"
- Caps the summary at 2 sentences
- Orders roles most recent first and caps bullets: 4 for the most recent role, 2 for each earlier role
- Caps Projects at 2 entries with 3 highlights each, and categorized skills at 4 rows
- Drops self-employment bullets that restate a featured project, always keeping at least one

The caps are the exported `RESUME_BUDGET` constant. They target a one-page résumé's content; physical page fit depends on each consumer's layout.

**Pinned roles.** An employment entry marked `pinned: true` in the profile carries owner-written bullets and always comes from the profile, never the model. The model sees pinned roles only as context and is told not to output them; post-processing drops any model copy and inserts each pinned role once, with its company, title, dates and bullets verbatim, exempt from caps and dedupe. The model can't mark a role pinned. The nightly sync never proposes or applies replacement bullets for a pinned entry.

## Rubric

| Id | Rule | Measurement | Pass |
|---|------|-------------|------|
| 1 | JD title in summary | Distinctive title keywords in the first sentence | 60% of title words |
| 2 | Keyword coverage | % of JD terms found across the résumé | 25%+ |
| 3 | Quantified bullets | % of employment bullets and project highlights containing metrics | 40%+ |
| 4 | Authenticity (no generic phrases) | Count of `BANNED_PHRASES` found | 0 (**hard veto**, score 0) |
| 7 | Skills ordered by JD relevance | Top 5 skills appearing in the JD | 40%+ |

Ids are stable identifiers; id 5 is unused since the old "first bullet matches JD" rule was removed.

**Overall pass threshold:** `PASS_THRESHOLD` = 4.0 of 5.

**STAR/XYZ is not scored here.** A regex can't tell a result from an intention, so bullet shape is required by the prompt and measured by an LLM judge off the request path (see Eval).

**Hard veto:** Rule 4 scores 0, so a candidate with a banned phrase loses to the other. `BANNED_PHRASES` includes weak verbs ("utilized", "utilizing", "participated in", "enhanced"); `stripBannedPhrases` replaces each with a plain substitute before scoring. "Functions as" and "responsible for" are deliberately not banned: they are weak only as a bullet's opening, which the prompt's bullet grammar forbids and the STAR/XYZ judge reports, and banning them anywhere rewrote ordinary prose ("Lambda functions as microservices"). Pinned roles are exempt from this rule, since their text is the owner's and is never stripped. If both candidates contain banned phrases, the higher-scoring one still ships with a warning logged. The nightly sync also rejects proposed project highlights that contain any banned phrase.

**Prompt-only rules** (not scored): summary of at most 2 sentences with no abstract descriptors; bullet grammar (past-tense opening verb, no trailing period, no `&`, no slashes between alternatives); never invent or estimate a metric; categorized skills of concrete tools; self-employment framed as the JD's role without restating featured projects; 1–2 JD-relevant projects.

All rules are deterministic (string matching, regex, keyword overlap); no LLM call scores a résumé.

## Why Dual-Gen Over Retry

| Factor | Retry loop | Dual-gen (chosen) |
|---|---|---|
| Diversity | Low — anchored on first attempt | High — independent cold starts |
| Latency | Sequential (slow on retry) | Parallel (same wall-clock as single) |
| Quality ceiling | Limited by one chain of thought | Wider sampling |
| Complexity | Re-prompt construction + state machine | Fire two, score, pick max |
| Cost | 1-2 LLM calls | 2 LLM calls always (cost varies by model; $0 with OpenRouter free-tier model IDs) |

## Failure Logging & Learning

When neither generation passes the rubric threshold:

1. **Ship the best anyway** — a below-threshold resume is better than no resume
2. **Log a structured failure** to OB1 thoughts with topic `resume-failure`:
   - Best score achieved
   - Which rules failed and why
   - JD snippet for context
3. **Surface patterns** via `/recall resume failures` in future sessions
4. **Human reviews** and tunes the system prompt or rule thresholds

The system never auto-tunes its own thresholds or rewrites its own prompt. Ground truth comes from interview callbacks, not LLM self-assessment.

## Response Format

The `/resume` response now includes a `_rubric` metadata key:

```json
{
  "contact": { ... },
  "summary": "...",
  "skills": [...],
  "employment": [...],
  "education": [...],
  "projects": [...],
  "_rubric": {
    "total": 4.85,
    "passed": true,
    "rules": [
      { "rule": 1, "name": "JD title in summary", "pass": true, "score": 1.0, "detail": "..." },
      ...
    ],
    "candidates_scored": 2
  }
}
```

The `_rubric` key is metadata for callers to log or surface — it does not affect the resume content fields.

## Eval

`npm run eval:resume` (`scripts/eval/run-resume-eval.ts`) runs synthetic job descriptions across several role types through `generateResume` against the live profile. Each case passes or fails on deterministic checks: format and budget invariants, categorized skills, absence of banned phrases, every number in a bullet grounded in the candidate's written text or the thoughts the model was given, and pinned roles verbatim. An LLM judge also reports, without gating, how many generator-written employment bullets follow STAR/XYZ, with a reason for each miss.

Two related on-demand commands share that judge (`scripts/eval/star-judge.ts`):

- `npm run check:bullets` reviews the profile's stored employment bullets and lists those that don't state a result. The generator can only adapt stored bullets, so this is where STAR quality is fixed.
- `npm run eval:star-judge` checks the judge against a labeled calibration set (`scripts/eval/star-judge-calibration.ts`) and reports agreement. Run it after changing the judge prompt or model.

None of these run in `test:unit`, the weekly eval workflow, or `/resume` itself.

## Tests

| File | What's covered |
|---|---|
| `tests/score-resume.test.ts` | Each scored rule with pass/fail fixtures, title extraction, overall scoring |
| `tests/resume-format.test.ts` | Post-processing invariants, pinned roles, the pass threshold |
| `tests/strip-banned.test.ts` | Every banned phrase is removed or replaced |
| `tests/resume-framing.test.ts` | Schema validation, prompt injection, framing hint formatting |
