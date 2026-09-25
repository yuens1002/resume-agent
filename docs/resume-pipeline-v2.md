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

`normalizeResumeFormat` (`src/lib/resume-format.ts`) runs before scoring, so the rubric scores what ships. It only removes or rewords; it never adds content or a number.

- Strips trailing periods from bullets and spells out a standalone `&` as "and"
- Caps the summary at 2 sentences
- Orders roles most recent first and caps bullets: 4 for the most recent role, 2 for each earlier role
- Caps Projects at 2 entries with 3 highlights each, and categorized skills at 4 rows
- Drops self-employment bullets that restate a featured project, always keeping at least one

The caps are the exported `RESUME_BUDGET` constant. They target a one-page résumé's content; physical page fit depends on each consumer's layout.

**Pinned roles.** An employment entry marked `pinned: true` in the profile carries owner-written bullets. The prompt tells the model to copy them verbatim, and post-processing restores them from the profile regardless of what the model returned, exempt from caps and dedupe. A pinned entry the model dropped is restored. The nightly sync never proposes or applies replacement bullets for a pinned entry.

## Rubric

| Id | Rule | Measurement | Pass |
|---|------|-------------|------|
| 1 | Summary opens with JD title | Distinctive title keywords in the first sentence | 60% of title words |
| 5 | STAR/XYZ bullet shape | Share of generator-selected employment bullets that open with a past-tense verb and state a result: a real metric or an outcome clause (", replacing …", "so … could", "used by", "without …"); incidental digits like version numbers don't count. Pinned entries and project highlights are excluded | 50%+ |
| 2 | Keyword coverage from JD | % of JD terms found across the résumé | 25%+ |
| 3 | Quantified results | % of employment bullets and project highlights containing metrics | 40%+ |
| 4 | No generic or weak phrases | Count of `BANNED_PHRASES` found | 0 (**hard veto**, score 0) |
| 7 | Top skills match JD | Top 5 skills appearing in the JD | 40%+ |

Rules are listed in the order `scoreResume` returns them; ids are stable identifiers, which is why the STAR/XYZ rule (id 5, the slot freed when the old "first bullet matches JD" rule was removed) sits second.

**Overall pass threshold:** `PASS_THRESHOLD` = 4.8 of 6. It was 4.0 of 5 before the STAR/XYZ rule; 4.8 keeps the same ratio.

**Hard veto:** Rule 4 scores 0, so a candidate with a banned phrase loses to the other. `BANNED_PHRASES` includes weak or passive openings ("utilized", "participated in", "enhanced", "functions as", "responsible for"); `stripBannedPhrases` replaces each with a plain substitute before scoring. If both candidates contain banned phrases, the higher-scoring one still ships with a warning logged. The nightly sync also rejects proposed project highlights that contain any banned phrase.

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

`npm run eval:resume` (`scripts/eval/run-resume-eval.ts`) runs synthetic job descriptions across several role types through `generateResume` against the live profile and checks each output's format and budget invariants, categorized skills, STAR/XYZ share, absence of banned phrases, and that every number in the résumé appears in the profile. It runs on demand only; it is not part of `test:unit` or the weekly eval workflow.

## Tests

| File | What's covered |
|---|---|
| `tests/score-resume.test.ts` | Each scored rule with pass/fail fixtures, title extraction, overall scoring |
| `tests/resume-format.test.ts` | Post-processing invariants, pinned roles, the STAR/XYZ rule, the pass threshold ratio |
| `tests/strip-banned.test.ts` | Every banned phrase is removed or replaced |
| `tests/resume-framing.test.ts` | Schema validation, prompt injection, framing hint formatting |
