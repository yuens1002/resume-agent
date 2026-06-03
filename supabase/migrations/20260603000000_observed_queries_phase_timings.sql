-- Phase timing breakdown for observed_queries.
-- `latency_ms` (existing) remains the wall-clock total. These split it:
--   llm_ms       — generateText() duration (the LLM generation phase)
--   retrieval_ms — data-fetch phase (profile + thoughts Promise.all)
-- Overhead = latency_ms - llm_ms - retrieval_ms (prompt construction, JSON
-- parse/serialize, framework, network, cold start — local CPU + infra, not just infra).
-- Nullable: streaming callers log a partial payload without the breakdown.

alter table observed_queries add column if not exists llm_ms integer;
alter table observed_queries add column if not exists retrieval_ms integer;
