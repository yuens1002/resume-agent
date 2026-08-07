-- Make the default semantic-search RPC privacy-safe, and give the owner-only
-- surface an explicitly named unguarded sibling (#235).
--
-- Before this migration `match_thoughts` (20260326000000_ob1_thoughts.sql) had no
-- privacy clause, yet it backed `queryRelevantThoughts` — which serves BOTH the
-- public `POST /query` and `POST /resume`. Nothing leaked, but only because that
-- caller passes `filter: {status:'shipped', source:'enrichment'}`, and
-- `source: 'enrichment'` happens to be written by exactly one producer (the public
-- changelog ledger in scripts/sync.ts). That is an emergent property of the current
-- producer set, not a boundary: a private row edited into that shape, or a relaxed
-- filter, would put private content into a generated résumé.
--
-- `source` is a particularly bad thing to lean on for privacy — per #234 it was
-- silently rewritten on 122 rows for reasons unrelated to visibility, and went
-- unnoticed until an unrelated audit.
--
-- The fix inverts which path is the accident: the DEFAULT is now guarded, and an
-- unguarded read must name `match_thoughts_owner` explicitly. Same fail-closed
-- direction as the #222 authored allowlist and #233's default inversion.
--
-- Both guards use the JSONB containment operator `@>` so they stay accelerated by
-- the existing GIN index on thoughts.metadata. A thought is excluded only when
-- metadata.private is the JSON boolean `true`; absent, false, or null are public.

-- ── 1. match_thoughts — now guarded ──────────────────────────────────────────
-- Signature and defaults unchanged, so every existing caller keeps working; the
-- only behavioural change is that private rows are no longer returned.
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
    and not (t.metadata @> '{"private": true}'::jsonb)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- ── 2. match_thoughts_owner — deliberately unguarded ─────────────────────────
-- The owner's own view of their brain, reached only through the authenticated
-- private MCP (`/mcp`, src/routes/mcp.ts). It returns private thoughts BY DESIGN.
--
-- Never call this from a public surface. If you are adding a caller and it is not
-- the private MCP, you almost certainly want `match_thoughts`.
create or replace function match_thoughts_owner(
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

-- Note: match_thoughts_public (20260512000000) is now functionally equivalent to
-- the guarded match_thoughts. Left in place deliberately — its callers are correct
-- and renaming them would be churn with no behavioural gain. Worth collapsing the
-- two in a later cleanup, not in a privacy fix.
