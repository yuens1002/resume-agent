-- Enable RLS on observed_queries and restrict access to service_role only.
-- The table stores potentially sensitive content (questions + LLM answers);
-- this matches the access model of other non-public tables in this schema.

alter table observed_queries enable row level security;

revoke all on table observed_queries from public;
revoke all on table observed_queries from anon;
revoke all on table observed_queries from authenticated;
grant all on table observed_queries to service_role;

create policy "Service role full access"
  on observed_queries
  for all
  to service_role
  using (true)
  with check (true);
