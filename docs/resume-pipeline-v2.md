# Resume Pipeline v2 — Dual-Gen + Rubric Scorer

## Problem

The v1 `/resume` endpoint produced a single LLM-generated resume per JD. Quality varied significantly between runs — the same prompt could yield a "Full-stack engineer" summary for a "Sr UX Engineer" role, miss key JD keywords, or produce generic bullets lacking real metrics. There was no way to detect or prevent these failures.

## Architecture

```
POST /resume  { job_description, framing_hints? }
  │
  ├─ Fetch candidate profile from OB1 Postgres (Supabase DB)
  ├─ Build system prompt (6 ATS rules)
  ├─ Build user message (profile + JD + framing hints)
  │
  ├─ ┌─ generateOne() ─┐  (parallel, independent)
  │  └─ generateOne() ─┘
  │
  ├─ scoreResume(gen1, jd)
  ├─ scoreResume(gen2, jd)
  │
  ├─ Pick highest total score
  │
  ├─ If neither passes threshold:
  │    └─ Log RESUME_RUBRIC_FAILURE to OB1 thoughts
  │
  └─ Return winner + _rubric metadata
```

## The 8 Rules (ATS-Informed) — 6 Scored + 2 Prompt-Only

| # | Rule | Measurement | Pass threshold |
|---|------|-------------|----------------|
| 1 | Summary opens with JD title | Distinctive title keywords in first sentence | 60% of title words |
| 2 | Keyword coverage from JD | % of JD terms found across resume | 25%+ |
| 3 | Bullets have quantified results | % of bullets containing metrics | 40%+ |
| 4 | No generic/banned phrases | Count of banned phrases found | 0 (**hard veto** — score 0) |
| 5 | First bullet matches JD primary resp | Keyword overlap with JD opening | 5%+ overlap |
| 6 | Top skills match JD requirements | Top 5 skills appearing in JD | 40%+ |
| 7 | Self-employment framed as JD role | Prompt rule (not scored) | N/A |
| 8 | Projects section for highlights/scale | Prompt rule (not scored) | N/A |

**Overall pass threshold:** 4.0 / 6.0 total score (Rules 1-6 scored; Rules 7-8 are prompt-only).

**Hard vetoes:** Rule 4 scores 0 (not a penalty) — any banned phrase causes the resume to lose to the other candidate. Edge case: if both candidates contain banned phrases, the higher-scoring one still ships (with a warning logged). If only one candidate parsed successfully, it ships regardless of Rule 4.

Rules 1-4 are fully deterministic (string matching, regex). Rules 5-6 use keyword overlap (no LLM needed). Rules 7-8 are prompt instructions only (not scored by the rubric).

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

## Test Coverage

| File | Tests | What's covered |
|---|---|---|
| `tests/score-resume.test.ts` | 18 | All 6 rules with pass/fail fixtures, title extraction, overall scoring |
| `tests/resume-framing.test.ts` | 18 | Schema validation, prompt injection, framing hint formatting |

## Files Changed

- `src/routes/resume.ts` — New system prompt (6 rules), dual-gen, rubric scoring, failure logging
- `src/lib/score-resume.ts` — **New** — Deterministic rubric scorer (6 rules, pure function)
- `tests/score-resume.test.ts` — **New** — 16 unit tests for the scorer
- `docs/resume-pipeline-v2.md` — This document
