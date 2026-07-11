-- action_intent routing signal for observed_queries (#195).
--
-- Monitoring prerequisite (order-of-work step 1 in #195): observed_queries
-- had no way to see which questions the classifier routed to
-- open_match_tool vs narrate. #194 was only caught because the owner
-- manually tested live traffic — this column makes future routing
-- regressions queryable directly from production logs instead of requiring
-- that live forensic reconstruction again.
--
-- Nullable text: the tool name the classifier routed to (e.g.
-- 'open_match_tool'), or null for a narrated answer.

alter table observed_queries add column if not exists action_intent text;
