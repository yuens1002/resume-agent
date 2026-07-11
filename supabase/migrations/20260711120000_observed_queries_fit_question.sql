-- fit_question routing signal for observed_queries (#199).
--
-- The classifier gained a third route, narrate_fit (fit/suitability
-- QUESTIONS, answered in prose per the narrate-first spec #195, flagged so
-- the frontend can offer the fit-check chip). Logging it alongside
-- action_intent lets the #195 judge sweep score the full three-way route
-- decision from production traffic instead of only the tool/no-tool binary.
--
-- Nullable boolean: true/false for non-streaming responses, null for
-- streaming callers that log a partial payload.

alter table observed_queries add column if not exists fit_question boolean;
