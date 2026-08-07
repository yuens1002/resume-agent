-- public_profile: single-row table representing the candidate's public-facing profile.
-- All sections stored as JSONB for flexibility. RLS allows public read, no public write.

-- Replay-safe (#237): db-push.ts re-runs every migration on every invocation, so each
-- statement here has to tolerate already-applied state. `create table` and `create policy`
-- previously aborted the whole run on the first file, which meant no migration after this
-- one was ever applied by `npm run db:push` against an existing database.
create table if not exists public_profile (
  id          uuid        primary key default '00000000-0000-0000-0000-000000000001'
                          check (id = '00000000-0000-0000-0000-000000000001'),
  contact     jsonb       not null default '{}',
  summary     text        not null default '',
  skills      jsonb       not null default '[]',
  employment  jsonb       not null default '[]',
  education   jsonb       not null default '[]',
  projects    jsonb       not null default '[]',
  availability jsonb      not null default '{}',
  updated_at  timestamptz not null default now()
);

-- RLS: allow anyone to read, nobody to write via API
alter table public_profile enable row level security;

-- PostgreSQL has no `create policy if not exists`, so drop-then-create is the only
-- idempotent form. Safe: the policy is recreated immediately below in the same file.
drop policy if exists "public read" on public_profile;
create policy "public read"
  on public_profile
  for select
  using (true);

-- Seed a single empty row so GET /info always has something to return
insert into public_profile (id) values ('00000000-0000-0000-0000-000000000001')
  on conflict (id) do nothing;
