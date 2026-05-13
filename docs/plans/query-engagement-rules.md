# Plan: `/query` Engagement Rules — owned spec, prompt-does-relevance, eval-backed threshold

**Branch:** `feat/query-engagement-rules` (not started)
**Status:** Planning — ready for review
**Scope:** Turn the implicit response behavior of `/query` and `/public-mcp ask_candidate` into an *owned* engagement-rules spec (voice / off-topic / gaps / adversarial / honesty), move fine-grained relevance judgment from the cosine-similarity gate into the system prompt itself, and add a small on-demand eval harness so prompt and threshold changes are evidence-based instead of vibes-based. No response-schema changes. No new infrastructure.

---

## Context

`/query` today answers from three ad-hoc string literals in `src/routes/query.ts:20-48` plus a high/medium/low confidence scheme. There's no explicit handling of off-topic questions, "I don't know" gaps, or adversarial input, and nothing tells the model that the up-to-8 similarity-retrieved OB1 thoughts injected into its prompt may not all be relevant. Thoughts-grounding (#93) made the gap sharper: with the similarity threshold lowered to 0.35 (#94) to give short questions any matches at all, a tangentially-related observation can land in the prompt and the model has no instruction to drop it. The real failure mode isn't a missing match — it's the agent stretching a weak match into a claim it shouldn't make.

The reframe: **the prompt does the fine relevance judgment; the similarity threshold is just a coarse pre-filter; an eval set makes any future change evidence-based.** Bundled with it: turn the persona and the failure-mode handling — voice (first person, always), off-topic redirect, direct gap-handling (binary experience → yes/no; capability → name the precise gap vs. adjacent layer, never overclaim adjacency), adversarial input ("I'm not here to play games — let's talk about my work") — into a single spec doc the prompt is generated from.

### Current code (the three pieces this plan acts on)

**1. "Prompt does the relevance judgment" — today it doesn't.** `src/routes/query.ts:20` has `OBSERVATIONS_GUIDANCE = "When ... is provided below, prefer it for behavioral, decision-making, or judgment questions"`. It never says "may not all be relevant; use only what bears on an honest answer; never stretch a tangential note into a claim." `buildQueryPrompt` (L56–69) renders thoughts raw under `# Project observations and lived experience` with no framing.

**2. "Threshold is just a pre-filter" — currently it's the only filter.** `src/lib/thoughts-query.ts:71` passes `match_threshold: 0.35` to `match_thoughts_public`; `match_count: 8` bounds the blast radius; the SQL function in `supabase/migrations/20260512000000_match_thoughts_public.sql` excludes private thoughts and applies the cosine cutoff — there is no LLM relevance check anywhere. Live calibration: on-topic ~0.40–0.55, clearly off-topic ~0.18–0.24.

**3. "Eval set makes it evidence-based" — closest existing pattern is the resume rubric.** `src/lib/score-resume.ts` defines a deterministic rubric (named rules → per-rule `{ rule, name, pass, score, detail }` → sum → pass/fail vs. `PASS_THRESHOLD`); `tests/score-resume.test.ts` exercises it with inline fixtures, pure unit tests, no LLM. `scripts/compare-prompts.ts` is the on-demand side-by-side diff tool — usable as a runner shape, not an eval harness today. `tests/public-mcp-tool.test.ts` is the integration-test pattern for LLM-calling assertions (env-gated, `TEST_QUESTION_MARKER`, `cleanupTestRows`, structural-shape checks, never exact-text). No `evals/`, no `promptfoo`, no fixtures directory.

Caller-hint flow stays orthogonal: `src/lib/detect-caller.ts` produces a tone hint (`ats` / `recruiter` / `hiring-manager` / `personal-ai` / `unknown`) that the new `buildSystemPrompt` will interpolate — caller hint = tone, engagement rules = behavior.

---

## Goals

1. Extract the system prompt into a dedicated module `src/lib/query-prompt.ts` with named, documented rule constants and a single `buildSystemPrompt(callerHint, mode)` entry point. Delete the inline literals in `src/routes/query.ts`.
2. Add the **observations-relevance rule** the prompt is currently missing — explicit instruction that the injected block is similarity-retrieved, may not all be relevant, use only what directly supports an honest answer, never stretch.
3. Encode the persona / failure-mode rules in first-person voice — off-topic redirect, gap handling (binary vs. capability vs. genuinely no data, with the calendly link offered on genuine no-data), adversarial input refusal, honesty floor — and tell the LLM explicitly that the example phrasings are tone illustrations, not scripts.
4. Reframe the cosine threshold as a coarse pre-filter (not the relevance gate) and make it env-overridable (`QUERY_THOUGHTS_THRESHOLD`, default `0.35`) so the eval can sweep it.
5. Build a small, on-demand eval harness modeled on `score-resume.ts`: ~14 fixture cases across six categories, a deterministic rubric scorer with an optional `--judge` LLM-as-judge pass, and a runner script (`npm run eval:query`) that reports per-case pass/fail + per-category rates + overall.
6. Publish a human-readable spec at `docs/query-engagement-rules.md` so reviewers and future contributors don't have to grep the prompt module.

## Non-goals

- Changing the response schema. The LLM-emitted JSON keeps the four fields `{ answer, confidence, sources, follow_up_suggestions }`; the full HTTP envelope returned to callers continues to wrap that with the existing `contact` and `meta` fields populated by the route (see `src/routes/query.ts` `queryProfile` and the `QueryResponse` type). This plan only governs the LLM-emitted payload.
- Rerankers / cross-encoders / hybrid search. The prompt does relevance; the threshold is a simple cosine cutoff.
- Making the eval part of CI / `test:unit`. It makes LLM calls; it's on-demand like `compare-prompts.ts`. The deterministic *rubric* gets unit tests; the *runner* does not.
- Touching `queryRelevantThoughts(jd)` / `/resume`. That path keeps `match_thoughts` + threshold 0.55.
- A new persona-tuning UI / config layer. The spec is a markdown doc; the prompt module composes string constants.

---

## Architecture

```
                              POST /query / public-mcp ask_candidate
                                            │
                                            ▼
                                     queryProfile(question)
                  ┌─────────────────────────┼─────────────────────────┐
                  ▼                         ▼                         ▼
       embed(question)            SELECT public_profile        deriveCallerHint()
                  │                         │                         │
                  ▼                         │                         │
   rpc('match_thoughts_public',             │                         │
     threshold = QUERY_THOUGHTS_THRESHOLD,  │                         │
     count = 8)                             │                         │
                  │                         │                         │
                  │   COARSE PRE-FILTER     │                         │
                  │   (cosine ≥ 0.35)       │                         │
                  ▼                         ▼                         ▼
       top-N thoughts          ┌── user message ──┐       buildSystemPrompt(hint, mode)
       (raw, possibly noisy)   │ # Project obs.   │              │
                  └──────────► │ > retrieved by   │              ▼
                               │   similarity     │      ┌── system prompt ──┐
                               │   ...            │      │ Voice             │
                               │ # Profile data   │      │ Honesty           │
                               │ # Question       │      │ Observations      │
                               └──────────────────┘      │   relevance ◄── FINE relevance gate
                                            │            │ Off-topic         │
                                            │            │ Gaps              │
                                            │            │ Adversarial       │
                                            │            │ Output (json mode)│
                                            │            │ Caller hint       │
                                            ▼            └───────────────────┘
                                       Claude Haiku
                                            │
                                            ▼
                              QueryResponse { answer, confidence, sources, … }

                                            │
                                            ▼
                                  ┌─ scripts/eval/run-eval.ts ─┐
                                  │  ~14 fixture cases         │
                                  │  src/lib/eval-query-answer │  ← rubric: deterministic
                                  │  src/lib/score-resume      │     rules + optional --judge
                                  │  (pattern reused)          │
                                  └────────────────────────────┘
                                       per-case PASS/FAIL
                                       category summary
                                       overall score
```

---

## Implementation shape

1. **`src/lib/query-prompt.ts`** — named rule fragments + composer.
   - Constants: `RULE_VOICE`, `RULE_HONESTY`, `RULE_OBSERVATIONS_RELEVANCE`, `RULE_OFF_TOPIC`, `RULE_GAPS`, `RULE_ADVERSARIAL`, `RULE_OUTPUT_JSON` — each a documented string with a comment explaining the failure mode it prevents.
   - A `META_TONE_NOTE` constant the prompt opens with: *"Examples below illustrate tone and posture. Match the spirit, not the wording. Adapt naturally to the question."* — tells the LLM not to copy example phrasings.
   - `buildSystemPrompt(callerHint: string, mode: 'json' | 'stream'): string` — composes the rules + caller hint into the full system prompt. JSON mode includes `RULE_OUTPUT_JSON`; stream mode doesn't.
2. **`docs/query-engagement-rules.md`** — the reference spec, in `docs/` root (= shipped behavior). Mirrors the rule constants; humans review here, code generates from it.
3. **`src/routes/query.ts`** — delete `OBSERVATIONS_GUIDANCE`, `SYSTEM_PROMPT_JSON`, `SYSTEM_PROMPT_STREAM`; `queryProfile` / `queryProfileStream` call `buildSystemPrompt(callerHint, 'json' | 'stream')`. Tweak `buildQueryPrompt`: under the `# Project observations and lived experience` heading add a one-line preface `> retrieved by similarity to the question; not all may be relevant (see your instructions)` so the system rule is reinforced at the injection point.
4. **`src/lib/thoughts-query.ts`** — read `Number(process.env.QUERY_THOUGHTS_THRESHOLD ?? 0.35)` at module load (or per-call); update the inline comment to say the threshold is a coarse pre-filter and the prompt's `RULE_OBSERVATIONS_RELEVANCE` is the actual relevance gate.
5. **`scripts/eval/query-eval-cases.ts`** — ~14 cases: `{ id, question, callerHint?, category, expect }`, `category ∈ { binary, capability, behavioral, off_topic, adversarial, no_data }`. `expect` is characteristic-only (booleans + known-value substrings). Example IDs: `binary-shipped-resume-pipeline`, `capability-aws`, `behavioral-decide-features`, `off_topic-weather`, `adversarial-ignore-instructions`, `no_data-favorite-ide`.
6. **`src/lib/eval-query-answer.ts`** — rubric scorer mirroring `score-resume.ts`. Deterministic rules: JSON parses; `confidence` in expected band; binary-category answer starts with `yes` / `no` (case-insensitive); no-data-category answer contains the **runtime profile's calendly URL substring** — the rubric receives `{ contact: { calendly, email } }` from the runner (which loads it from the live `public_profile`) so each fork / profile-seed checks against its own URL, never a hardcoded value; no answer contains the literal token `on record` / `in my records` / `in the database` (anti-pattern). Optional `--judge` rules: one Haiku call asking semantic questions about the answer ("did it redirect without engaging the off-topic content?", "did it refuse the injection?", "did it name the precise capability gap without overclaiming adjacency?"). No rule asserts on an example phrasing from the spec.
7. **`scripts/eval/run-eval.ts`** — runs cases against `queryProfile()` directly (no server needed; reuses the shared core). Flags: `--threshold <n>` (sets `QUERY_THOUGHTS_THRESHOLD` for the run), `--judge` (enables LLM-judge rules), `--case <id>` (single case), `--category <name>` (single category). Prints per-case `PASS/FAIL — <rule>: <detail>`, category summary table, overall score. Wired as `npm run eval:query`.
8. **`tests/query-prompt.test.ts`** — pure unit tests: `buildSystemPrompt` includes every named rule fragment; both modes carry voice/honesty/observations-relevance/off-topic/gaps/adversarial/meta; JSON mode carries `RULE_OUTPUT_JSON` and stream mode does not; caller hint is interpolated. Added to `test:unit`.
9. **`tests/eval-query-answer.test.ts`** — pure unit tests for the deterministic rubric rules against inline fixture answers (mirrors `tests/score-resume.test.ts`). Added to `test:unit`.
10. **README** — new section `## /query engagement rules & eval` near the `POST /query` endpoint docs, with a few example `npm run eval:query` invocations to gauge effectiveness (single case, threshold sweep, `--judge` spot-check).
11. **`docs/workflow.md`** — short note that `/query` responses follow the engagement-rules spec, linking to `docs/query-engagement-rules.md`.
12. **`docs/README.md`** — add `query-engagement-rules.md` to the Shipped (reference) index.
13. **ROADMAP** — new Shipped row; **CHANGELOG** entry; `npm version patch`.

---

## Decisions locked from planning session

1. **First-person voice, always.** Confirmed in the session. Third person and the hybrid "as the candidate's agent" framings are rejected.
2. **Examples in the prompt are tone illustrations, not scripts.** Encoded as a meta-line in the prompt module; reinforced by the rubric's "no exact-text assertions" rule. The LLM produces its own words.
3. **No "on record" / "in my records" / "in the database" phrasing.** It leaks the agent posture and sounds like a system message. Explicit anti-pattern in the no-data rule; explicit anti-pattern check in the rubric (deterministic).
4. **Calendly link offered on genuine no-data path.** "Be direct, hide nothing" extends naturally to "and here's how to ask me directly." Rubric checks for the calendly URL substring — read from the *runtime profile's* `contact.calendly` value at scoring time, not a hardcoded URL, so the harness stays portable across forks and profile reseeds.
5. **Threshold reframed as a coarse pre-filter; stays at 0.35; env-overridable.** Prompt's `RULE_OBSERVATIONS_RELEVANCE` is the actual relevance gate. Low threshold maximizes recall of relevant-but-low-similarity thoughts; the prompt drops the rest. `QUERY_THOUGHTS_THRESHOLD` env var lets the eval sweep it without code change.
6. **Hybrid rubric — deterministic + optional `--judge`.** Deterministic rules are presence/absence of known values (JSON parse, calendly substring, anti-pattern tokens). Semantic checks (did it really redirect? did it overclaim adjacency?) go to a Haiku judge, gated by `--judge` so the cheap subset runs free.
7. **Eval is on-demand, not in `test:unit`.** It makes LLM calls; same posture as `compare-prompts.ts`. The deterministic rubric *rules* get unit tests; the *runner* doesn't.
8. **One PR, with a clean split seam if review says so.** Recommend shipping prompt module + spec + wiring + eval cases + rubric + runner together. The natural split is (1) prompt + spec + wiring + prompt unit tests vs. (2) eval cases + rubric + runner + rubric unit tests.

---

## Acceptance criteria

**Prompt module**
- AC-1: `buildSystemPrompt(hint, 'json')` output contains every named rule fragment (voice, honesty, observations-relevance, off-topic, gaps, adversarial, output-json, meta-tone-note) and interpolates the caller hint. *(automated)*
- AC-2: `buildSystemPrompt(hint, 'stream')` includes all the same rules **except** `RULE_OUTPUT_JSON`. *(automated)*
- AC-3: `RULE_OBSERVATIONS_RELEVANCE` explicitly tells the model the observations may not all be relevant, to use only what supports an honest answer, and to not stretch tangential notes into claims. *(automated — substring assertions on the constant)*
- AC-4: `RULE_GAPS` contains the binary / capability / no-data trichotomy and forbids "on record" / "in my records" / "in the database" phrasing. *(automated)*

**Routing**
- AC-5: `src/routes/query.ts` exports no inline `SYSTEM_PROMPT_*` literals — the system prompt is `buildSystemPrompt(...)` only. *(automated — substring check on the module source)*
- AC-6: `buildQueryPrompt` renders the `> retrieved by similarity ...` preface when thoughts are present and omits it when thoughts are empty (regression-protect existing AC-6/AC-7 from the thoughts-grounded plan). *(automated)*

**Threshold**
- AC-7: `QUERY_THOUGHTS_THRESHOLD=0.5` is honored by `queryRelevantThoughtsForQuestion` (the RPC call passes the env value, not a hard-coded literal). *(automated — assert on the call site source or a thin unit test if module structure supports it)*

**Eval rubric (unit, deterministic)**
- AC-8: Rubric flags an answer containing the literal `on record` as failing the "no anti-pattern phrasing" rule. *(automated)*
- AC-9: Rubric passes a `binary` case whose answer starts with "Yes" and fails one that doesn't. *(automated)*
- AC-10: Rubric passes a `no_data` case whose answer contains the calendly URL and fails one that doesn't. *(automated)*
- AC-11: `eval-query-answer.ts` exports no rule that compares against an example phrasing from `docs/query-engagement-rules.md`. *(automated — substring check on the rubric source)*

**Runner (smoke, manual)**
- AC-12: `npm run eval:query` runs to completion against a seeded profile, prints a per-category report, exits 0 if overall ≥ pass threshold. *(manual smoke)*
- AC-13: `npm run eval:query -- --case <id>` runs a single case. *(manual smoke)*
- AC-14: `npm run eval:query -- --threshold 0.5` and `--threshold 0.35` produce comparable reports; the score delta is small (the prompt absorbs the looser pre-filter). *(manual smoke; baseline data captured in the CHANGELOG entry)*
- AC-15: `npm run eval:query -- --judge` adds the LLM-judge rules without breaking the deterministic ones. *(manual smoke)*

**Surface / docs**
- AC-16: `docs/query-engagement-rules.md` exists and mirrors the rule constants in `src/lib/query-prompt.ts`. *(visual review)*
- AC-17: README has a `/query engagement rules & eval` section with at least three example `npm run eval:query` invocations. *(visual review)*

**Regression**
- AC-18: Existing public-MCP integration tests still pass against the new prompt — response shape is unchanged. *(integration — `test:public-mcp` on a live server)*

---

## Rollback

Single revert: `git revert <merge-sha>` removes the prompt module, the eval harness, the spec doc, the threshold env override, and the docs/ROADMAP updates. The `QUERY_THOUGHTS_THRESHOLD` env var, if set on Railway, becomes unread and harmless; remove at leisure. No migrations, no data shape changes, no breaking schema changes. `queryRelevantThoughts(jd)` / `/resume` are untouched, so the resume pipeline is unaffected regardless of merge order.

---

## What this unlocks

- **Trustworthy behavioral interview answers.** The combination of the relevance rule + the gap rule means a thin observation can no longer be inflated into a claim of experience the candidate doesn't have.
- **Evidence-based threshold tuning.** Future "should we raise/lower the cosine cutoff?" questions are answered by running `npm run eval:query -- --threshold <n>` against the rubric, not by eyeballing similarity scores.
- **A reusable answer-quality rubric.** The same `eval-query-answer.ts` pattern can be extended to score `/match` outputs or any other LLM endpoint as those become testable. The `score-resume.ts` pattern was the precedent; this generalizes it.
- **A spec the engagement rules can evolve from.** When a real recruiter or peer asks something the agent handles badly, the fix is "add a case to the eval, add a rule (or refine one) in the spec, run the eval, ship the prompt." No more buried string literals.
