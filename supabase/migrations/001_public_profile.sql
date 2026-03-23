-- public_profile: single-row table representing the candidate's public-facing profile.
-- All sections stored as JSONB for flexibility. RLS allows public read, no public write.

create table public_profile (
  id          uuid        primary key default gen_random_uuid(),
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

create policy "public read"
  on public_profile
  for select
  using (true);

-- Seed a single empty row so GET /info always has something to return
insert into public_profile (id) values ('00000000-0000-0000-0000-000000000001');
