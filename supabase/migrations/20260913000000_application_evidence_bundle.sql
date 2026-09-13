-- ============================================================
-- Application Evidence Bundle
--
-- job_applications' job_description column was already being populated at
-- every log_application call but never returned by get_application /
-- search_applications (fixed in code alongside this migration). Neither the
-- exact tailored resume content nor the submitted file was ever persisted at
-- all — once job-hunt-agent's local /output copy was cleaned up, both were
-- gone permanently. This adds the durable side: the exact resume content and
-- file (with a hash) per submission, and an append-only scoring history so a
-- rescore never overwrites a prior score.
-- ============================================================

-- ── job_applications: widen the stage check constraint ────
-- `is_submitted` on application_resumes is meaningless as a signal if
-- job_applications.stage still gets forced to 'applied' regardless — every
-- consumer that counts/dedupes by stage (the pipeline feed's by_stage
-- totals, job-hunt-agent's already-applied dedupe checks) would keep
-- treating a merely-tailored, not-yet-submitted entry as a real submission.
-- Adds 'draft' as a distinct pre-submission stage so log_application (below)
-- can record the true state instead of overloading 'applied'.
alter table job_applications drop constraint if exists job_applications_stage_check;
alter table job_applications add constraint job_applications_stage_check
  check (stage in ('draft', 'applied', 'phone_screen', 'technical', 'final', 'offer', 'rejected', 'withdrawn'));

-- ── Table: application_resumes ────────────────────────────
-- One row per resume version tied to a real application. `is_submitted`
-- distinguishes the one actually sent from any future re-tailoring attempt —
-- "generated" is not "submitted".
create table if not exists application_resumes (
  id              uuid        primary key default gen_random_uuid(),
  application_id  uuid        not null references job_applications(id) on delete cascade,

  resume_content  jsonb       not null,

  docx_url        text,
  docx_hash       text,
  pdf_url         text,
  pdf_hash        text,

  is_submitted    boolean     not null default false,
  generated_at    timestamptz not null default now()
);

-- `create table if not exists` above is a no-op on replay against a database
-- that already has this table, so it never picks up a changed column
-- default on its own — this applies it explicitly. Default is `false`, not
-- `true`: a future writer that omits `is_submitted` (a draft/re-tailor path)
-- must land as a non-submitted version, not silently collide with the one
-- submitted row the unique index below enforces. The one writer that
-- actually submits (`log_application` in mcp.ts) always sets it explicitly.
alter table application_resumes alter column is_submitted set default false;

create index if not exists application_resumes_application_id_idx on application_resumes (application_id);
-- Enforces exactly one submitted resume version per application.
create unique index if not exists application_resumes_one_submitted_idx
  on application_resumes (application_id) where is_submitted;
-- Backs the composite FK below — application_scores.resume_id must belong to
-- the same application_id it's scored against, not just any resume row.
-- `id` alone is already unique (it's the primary key); this pairs it with
-- application_id so a composite foreign key can reference both together.
create unique index if not exists application_resumes_application_id_id_idx
  on application_resumes (application_id, id);

-- ── Table: application_scores ─────────────────────────────
-- Append-only: every scoring event gets a new row, a rescore never updates
-- an existing one. resume_id is nullable because a JD-fit score can be
-- computed before any resume exists — the submission-time jd_fit row
-- populated by log_application does set it, tying that score to the
-- resume it was submitted alongside.
create table if not exists application_scores (
  id                  uuid        primary key default gen_random_uuid(),
  application_id      uuid        not null references job_applications(id) on delete cascade,
  resume_id           uuid        references application_resumes(id) on delete set null,

  score_type          text        not null check (score_type in ('jd_fit', 'resume_quality')),
  score               numeric(4,2),
  rationale           text,
  requirement_evidence jsonb,
  model               text,
  rubric_version      text,

  scored_at           timestamptz not null default now()
);

create index if not exists application_scores_application_id_scored_at_idx on application_scores (application_id, scored_at desc);
create index if not exists application_scores_resume_id_idx on application_scores (resume_id) where resume_id is not null;

-- `create table if not exists` above is a no-op on replay, so this widens
-- the plain single-column FK to a composite one on every run (drop-then-add
-- is idempotent; a bare `add constraint` is not, since Postgres has no
-- `add constraint if not exists`). Without this, resume_id only has to
-- exist in application_resumes at all — a score for application A could
-- reference a resume row that actually belongs to application B, and
-- nothing would catch it. NULL in either FK column still exempts the row
-- (MATCH SIMPLE, Postgres's default), so a jd_fit score recorded with no
-- resume attached is unaffected.
alter table application_scores drop constraint if exists application_scores_resume_id_fkey;
alter table application_scores add constraint application_scores_resume_id_fkey
  foreign key (application_id, resume_id) references application_resumes (application_id, id) on delete set null;

-- ── RLS ───────────────────────────────────────────────────
alter table application_resumes enable row level security;
alter table application_scores  enable row level security;

drop policy if exists "Service role full access" on application_resumes;
create policy "Service role full access" on application_resumes
  for all using (auth.role() = 'service_role');

drop policy if exists "Service role full access" on application_scores;
create policy "Service role full access" on application_scores
  for all using (auth.role() = 'service_role');

-- ── Grants ────────────────────────────────────────────────
grant select, insert, update, delete on table public.application_resumes to service_role;
-- No update/delete: application_scores is documented as append-only above —
-- the RLS policy alone doesn't enforce that (`for all` covers every
-- operation the grant permits), so this is the actual enforcement layer. A
-- future rescore/maintenance path must insert a new row, never touch an
-- existing one. GRANT is additive and never revokes a prior broader grant on
-- replay (this table's very first migration run granted update/delete too),
-- so the REVOKE is required, not just a narrower GRANT — a bare
-- `grant select, insert` alone would leave update/delete from that first
-- run still in effect.
revoke update, delete on table public.application_scores from service_role;
grant select, insert on table public.application_scores to service_role;

-- ── Storage bucket ────────────────────────────────────────
-- Private — resumes carry PII, never served directly, only through the
-- authenticated MCP path. `on conflict do nothing` means the insert alone
-- doesn't enforce `public = false` if the bucket already existed (e.g.
-- created public via the dashboard before this migration ever ran) — the
-- explicit update below does, unconditionally, on every replay.
insert into storage.buckets (id, name, public)
values ('resume-artifacts', 'resume-artifacts', false)
on conflict (id) do nothing;
update storage.buckets set public = false where id = 'resume-artifacts';

drop policy if exists "Service role full access to resume-artifacts" on storage.objects;
create policy "Service role full access to resume-artifacts" on storage.objects
  for all using (bucket_id = 'resume-artifacts' and auth.role() = 'service_role');
