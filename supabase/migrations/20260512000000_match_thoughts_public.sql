-- Public-surface semantic search over thoughts.
--
-- Same shape as match_thoughts (20260326000000_ob1_thoughts.sql) but excludes
-- any thought explicitly flagged private via `metadata.private = true`. Used by
-- the public /query and /public-mcp surfaces. The private MCP keeps using
-- match_thoughts (and /resume filters that further by status: shipped).
--
-- The privacy guard uses the JSONB containment operator `@>` so it is
-- accelerated by the existing GIN index on thoughts.metadata. A thought is
-- excluded only when metadata.private is the JSON boolean `true`; absent,
-- false, or null are all treated as public.

create or replace function match_thoughts_public(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.55,
  match_count int default 8,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
language plpgsql
as $$
begin
  return query
  select
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
    and not (t.metadata @> '{"private": true}'::jsonb)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;
