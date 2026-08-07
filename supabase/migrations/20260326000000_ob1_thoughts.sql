-- OB1 (Open Brain) — thoughts table + semantic search

-- Enable required extensions (idempotent — safe to run even if already enabled)
create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;

-- 2.2: Thoughts table + indexes
-- Replay-safe (#237). The index names below are NOT cosmetic: they are the names
-- PostgreSQL auto-generated on the first run. `create index if not exists` requires an
-- explicit name, and picking a different one would leave the original in place and build
-- a second copy alongside it. That is exactly what unnamed `create index` already did
-- here — a re-run silently produced thoughts_embedding_idx1 / _metadata_idx1 /
-- _created_at_idx1, ~32 MB of duplicates dropped by 20260807000000_drop_duplicate_indexes.
create table if not exists thoughts (
  id uuid default gen_random_uuid() primary key,
  content text not null,
  embedding extensions.vector(1536),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index for fast vector similarity search
create index if not exists thoughts_embedding_idx on thoughts
  using hnsw (embedding extensions.vector_cosine_ops);

-- Index for filtering by metadata fields
create index if not exists thoughts_metadata_idx on thoughts using gin (metadata);

-- Index for date range queries
create index if not exists thoughts_created_at_idx on thoughts (created_at desc);

-- Auto-update the updated_at timestamp (table-specific name avoids cross-migration collisions)
create or replace function thoughts_update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists thoughts_updated_at on thoughts;
create trigger thoughts_updated_at
  before update on thoughts
  for each row
  execute function thoughts_update_updated_at();

-- 2.3: Semantic search function
create or replace function match_thoughts(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.7,
  match_count int default 10,
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
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 2.4: Row Level Security
alter table thoughts enable row level security;

drop policy if exists "Service role full access" on thoughts;
create policy "Service role full access"
  on thoughts
  for all
  using (auth.role() = 'service_role');

-- 2.5: Grant service_role access (required on new Supabase projects)
grant select, insert, update, delete on table public.thoughts to service_role;
