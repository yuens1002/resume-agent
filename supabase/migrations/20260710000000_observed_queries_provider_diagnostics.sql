-- Provider/finish_reason diagnostics for observed_queries.
-- Added after #189: diagnosing a production-only reliability dip in
-- open_match_tool's routing required manually SSHing into the deployed
-- container to compare OpenRouter provider metadata against local calls.
-- Logging it here means a future recurrence of this pattern is queryable
-- directly instead of requiring that live forensic reconstruction again.
--   provider      — which upstream OpenRouter actually served the call
--                   (e.g. "Amazon Bedrock", "Anthropic"), when reported
--   finish_reason — the generation's finish reason (e.g. "stop", "tool-calls")
-- Nullable: not all providers report this, and streaming callers log a
-- partial payload with no meta at all.

alter table observed_queries add column if not exists provider text;
alter table observed_queries add column if not exists finish_reason text;
