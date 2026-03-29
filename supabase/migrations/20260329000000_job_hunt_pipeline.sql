-- ============================================================
-- Job Hunt Pipeline
-- ============================================================

-- pg_trgm enables efficient ILIKE '%...%' substring searches via GIN indexes
create extension if not exists pg_trgm;

-- ── Table 1: job_applications ─────────────────────────────
create table job_applications (
  id                 uuid        primary key default gen_random_uuid(),

  -- Core application data
  company            text        not null,
  role               text        not null,
  job_description    text,
  source             text,
  url                text,

  -- Pipeline state
  stage              text        not null default 'applied'
                                 check (stage in (
                                   'applied','phone_screen','technical',
                                   'final','offer','rejected','withdrawn'
                                 )),

  -- Match scoring (auto-populated by log_application when JD is provided)
  fit_score          numeric(4,2),
  match_verdict      text,
  match_scoring      jsonb,
  recommended_action text,

  -- Follow-up tracking
  follow_up_date     date,
  notes              text,

  -- Timestamps
  applied_at         timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index on job_applications (stage);
create index on job_applications (applied_at desc);
create index on job_applications (follow_up_date) where follow_up_date is not null;
-- GIN trigram indexes for efficient ILIKE '%...%' search on text columns
create index job_applications_company_trgm_idx  on job_applications using gin (company       gin_trgm_ops);
create index job_applications_role_trgm_idx     on job_applications using gin (role          gin_trgm_ops);
create index job_applications_jd_trgm_idx       on job_applications using gin (job_description gin_trgm_ops);
create index job_applications_notes_trgm_idx    on job_applications using gin (notes         gin_trgm_ops);

-- ── Table 2: application_stages (audit trail) ─────────────
create table application_stages (
  id              uuid        primary key default gen_random_uuid(),
  application_id  uuid        not null references job_applications(id) on delete cascade,
  stage           text        not null
                              check (stage in (
                                'applied','phone_screen','technical',
                                'final','offer','rejected','withdrawn'
                              )),
  note            text,
  occurred_at     timestamptz not null default now()
);

create index on application_stages (application_id, occurred_at desc);

-- ── Table 3: job_contacts ─────────────────────────────────
create table job_contacts (
  id              uuid        primary key default gen_random_uuid(),
  application_id  uuid        not null references job_applications(id) on delete cascade,

  name            text        not null,
  title           text,
  linkedin        text,
  email           text,
  notes           text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on job_contacts (application_id);

-- ── Triggers: updated_at ──────────────────────────────────
create or replace function pipeline_update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger job_applications_updated_at
  before update on job_applications
  for each row execute function pipeline_update_updated_at();

create trigger job_contacts_updated_at
  before update on job_contacts
  for each row execute function pipeline_update_updated_at();

-- ── RLS ───────────────────────────────────────────────────
alter table job_applications   enable row level security;
alter table application_stages enable row level security;
alter table job_contacts        enable row level security;

create policy "Service role full access" on job_applications
  for all using (auth.role() = 'service_role');

create policy "Service role full access" on application_stages
  for all using (auth.role() = 'service_role');

create policy "Service role full access" on job_contacts
  for all using (auth.role() = 'service_role');

-- ── Grants ────────────────────────────────────────────────
grant select, insert, update, delete on table public.job_applications   to service_role;
grant select, insert, update, delete on table public.application_stages to service_role;
grant select, insert, update, delete on table public.job_contacts        to service_role;
