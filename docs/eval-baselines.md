# Eval baselines

Correctness + latency snapshots recorded via `npm run eval:query -- --baseline --runs 3`.
Each row aggregates the median-of-N per-case latency. Compare rows to see which
commit moved latency. Upstream (OpenRouter/Haiku) variance is real — treat
sub-second deltas as noise. Optimize latency only with the pass rate held.

| date | version | runs/case | pass | total p50 | total p95 | llm p50 | retrieval p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-03 | 0.4.46 | 3 | 16/17 | 2471 | 10137 | 2059 | 445 |
| 2026-06-04 | 0.4.50 | 3 | 18/18 | 3183 | 11888 | 2765 | 482 |
| 2026-06-07 | 0.4.52 | 3 | 18/18 | 2407 | 11780 | 2025 | 354 |
| 2026-06-07 | 0.4.54 | 3 | 18/18 | 0 | 11316 | 0 | 0 |
