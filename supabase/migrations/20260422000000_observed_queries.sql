-- observed_queries: captures every question hitting the public query surface
-- (both HTTP POST /query and MCP ask_candidate tool). Source-agnostic by design —
-- the `source` column distinguishes origin. Written fire-and-forget from the
-- handler path so logging failures never break the response.

create table if not exists observed_queries (
  id            uuid primary key default gen_random_uuid(),
  source        text not null check (source in ('http', 'mcp')),
  question      text not null,
  caller_hint   text,
  answer        text,
  confidence    text,
  sources       jsonb,
  model         text,
  latency_ms    integer,
  ip_hash       text,
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index if not exists observed_queries_created_at_idx
  on observed_queries (created_at desc);

create index if not exists observed_queries_source_idx
  on observed_queries (source);
