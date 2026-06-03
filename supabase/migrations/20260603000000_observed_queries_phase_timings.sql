-- Phase timing breakdown for observed_queries.
-- `latency_ms` (existing) remains the wall-clock total. These split it:
--   llm_ms       — generateText() duration (the LLM generation phase)
--   retrieval_ms — data-fetch phase (profile + thoughts Promise.all)
-- Overhead = latency_ms - llm_ms - retrieval_ms (framework / network / cold start).
-- Nullable: streaming callers log a partial payload without the breakdown.

alter table observed_queries add column if not exists llm_ms integer;
alter table observed_queries add column if not exists retrieval_ms integer;
