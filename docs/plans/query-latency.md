# Plan: query latency — measure, then optimize

## Goal
`/query` averages ~6.6s wall-clock (p95 ~11s) on a fast model (Haiku). Reduce roundtrip **without degrading answer quality**. The eval harness already guards correctness; this plan adds the latency dimension and a disciplined loop.

## Core principle
Optimize latency **subject to correctness held constant.** Same fixtures, two metrics, measured on one pass — so you can't win on speed by quietly degrading answers.

## Stages

### Stage 1 — Production instrumentation (this PR)
We log wall-clock total but throw away the phase breakdown. Persist it:
- `llm_ms` — `generateText` time (already computed in `meta.latency_ms`, just not stored)
- `retrieval_ms` — the data-fetch phase (profile + thoughts `Promise.all`)
- Overhead = `total − llm − retrieval` — prompt construction, JSON parse/serialize, framework, network, cold start (local CPU *and* infra, not just infra), derivable

Migration adds two columns to `observed_queries`; `queryProfile` surfaces `retrieval_ms` in `meta`; logger persists both. Non-streaming only for now (streaming logs a partial payload — acceptable gap).

### Stage 2 — Latency on `eval:query` ✅ shipped
Per-case timing + aggregate p50/p95 in the eval run (`--runs N` for median-of-N). One command → correctness **and** latency on a fixed set. `--runs N` also majority-votes correctness across the N runs, killing behavioral single-run variance so the recorded pass rate is trustworthy. `--baseline` appends a row (date, version, pass rate, p50/p95) to the committed [`docs/eval-baselines.md`](../eval-baselines.md), so git history shows which commit moved latency.

### Stage 3 — Optimize against a target (later)
Set a target (e.g. p50 < 3s cited, < 1.5s conversational). Loop: change → `eval:query` → correctness held + latency down? → keep/revert.

## Key areas to investigate
1. **LLM output length** — cited mode generates long answers (prose + `[N]` + Sources + follow-ups, ≤1024 tokens). Output length, not model speed, dominates latency. Prime suspect.
2. **OpenRouter hop** — hot path routes through OpenRouter to reach Anthropic. Direct Anthropic could cut latency + p95 variance.
3. **Cold starts** — Railway container spin-up would show in p95/max tail, not p50.

## Cautions
- **Upstream variance is real** — same query swings seconds run-to-run. Run fixtures N times, compare medians, treat sub-second deltas as noise.
- **Two stores, complementary** — `observed_queries` = real traffic distribution + regression trend; eval harness = controlled "did my change help." Don't collapse them.
