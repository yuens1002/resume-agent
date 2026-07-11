-- Sibling column to `projects`: publications (blog posts, X threads, YouTube
-- scripts) surfaced as citable evidence alongside portfolio projects (#177).
-- Same idempotent single-column, JSONB, no-heavy-migration pattern as the
-- observed_queries incremental additions and add_tagline.
alter table public_profile add column if not exists publications jsonb not null default '[]'::jsonb;
