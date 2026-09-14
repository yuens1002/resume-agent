-- ============================================================
-- Immutable application-evidence capture and bounded snapshots
--
-- This migration never infers a version for historical rows. It only records
-- versions created by new writes after deployment, then materializes private
-- evidence snapshots so page reads cannot mix later source mutations.
-- ============================================================

begin;

create extension if not exists pgcrypto;

create table if not exists application_job_description_versions (
  id              uuid        primary key default gen_random_uuid(),
  application_id  uuid        not null references job_applications(id) on delete cascade,
  content         text        not null,
  content_hash    text        not null,
  source_url      text,
  captured_at     timestamptz not null default statement_timestamp(),
  created_at      timestamptz not null default now()
);

create index if not exists application_job_description_versions_application_id_captured_at_idx
  on application_job_description_versions (application_id, captured_at, id);

-- This backs the composite score FK below, ensuring a score cannot point at a
-- JD version from some other application.
create unique index if not exists application_job_description_versions_application_id_id_idx
  on application_job_description_versions (application_id, id);

-- The application writer is not the only possible future writer. Capturing at
-- the table boundary keeps every new non-null JD write versioned, while an
-- existing row stays explicitly legacy-unversioned rather than being guessed.
create or replace function public.capture_application_job_description_version()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.job_description is null then
    return new;
  end if;

  if tg_op = 'INSERT'
    or new.job_description is distinct from old.job_description
    or new.url is distinct from old.url then
    insert into public.application_job_description_versions (
      application_id, content, content_hash, source_url, captured_at
    ) values (
      new.id,
      new.job_description,
      encode(digest(convert_to(new.job_description, 'UTF8'), 'sha256'), 'hex'),
      new.url,
      statement_timestamp()
    );
  end if;
  return new;
end;
$$;

drop trigger if exists application_job_description_versions_capture on public.job_applications;
create trigger application_job_description_versions_capture
  after insert or update of job_description, url on public.job_applications
  for each row execute function public.capture_application_job_description_version();

alter table public.application_scores
  add column if not exists job_description_version_id uuid references public.application_job_description_versions(id) on delete set null,
  add column if not exists profile_hash text,
  add column if not exists rubric_hash text;

create index if not exists application_scores_job_description_version_id_idx
  on public.application_scores (job_description_version_id)
  where job_description_version_id is not null;

alter table public.application_scores
  drop constraint if exists application_scores_job_description_version_id_fkey;
alter table public.application_scores
  add constraint application_scores_job_description_version_id_fkey
  foreign key (application_id, job_description_version_id)
  references public.application_job_description_versions (application_id, id)
  on delete set null (job_description_version_id);

-- This records an internal confirmation event, not a verified external send
-- time or ATS outcome. New confirmations can identify how the confirmation
-- was attested; old submitted resumes deliberately remain unverified.
create table if not exists application_submission_confirmations (
  id                          uuid        primary key default gen_random_uuid(),
  application_id              uuid        not null references public.job_applications(id) on delete cascade,
  resume_id                   uuid        not null,
  actual_submission_occurred_at timestamptz,
  confirmation_recorded_at    timestamptz not null default statement_timestamp(),
  confirmation_source         text        not null check (confirmation_source in ('client_attested', 'unknown')),
  source_ref                  text,
  created_at                  timestamptz not null default now(),
  unique (application_id, resume_id),
  foreign key (application_id, resume_id)
    references public.application_resumes (application_id, id)
    on delete cascade
);

create index if not exists application_submission_confirmations_application_id_recorded_at_idx
  on public.application_submission_confirmations (application_id, confirmation_recorded_at, id);

create table if not exists application_evidence_snapshots (
  id                  uuid        primary key default gen_random_uuid(),
  as_of               timestamptz not null,
  total_applications  integer     not null check (total_applications >= 0),
  created_at          timestamptz not null default now()
);

create table if not exists application_evidence_snapshot_entries (
  snapshot_id     uuid  not null references application_evidence_snapshots(id) on delete cascade,
  ordinal         integer not null check (ordinal > 0),
  application_id  uuid  not null,
  evidence        jsonb not null,
  primary key (snapshot_id, ordinal),
  unique (snapshot_id, application_id)
);

create index if not exists application_evidence_snapshot_entries_snapshot_application_idx
  on application_evidence_snapshot_entries (snapshot_id, application_id);

alter table public.application_job_description_versions enable row level security;
alter table public.application_submission_confirmations enable row level security;
alter table public.application_evidence_snapshots enable row level security;
alter table public.application_evidence_snapshot_entries enable row level security;

drop policy if exists "Service role full access" on public.application_job_description_versions;
create policy "Service role full access" on public.application_job_description_versions
  for all using (auth.role() = 'service_role');

drop policy if exists "Service role full access" on public.application_submission_confirmations;
create policy "Service role full access" on public.application_submission_confirmations
  for select using (auth.role() = 'service_role');

drop policy if exists "Service role full access" on public.application_evidence_snapshots;
create policy "Service role full access" on public.application_evidence_snapshots
  for all using (auth.role() = 'service_role');

drop policy if exists "Service role full access" on public.application_evidence_snapshot_entries;
create policy "Service role full access" on public.application_evidence_snapshot_entries
  for all using (auth.role() = 'service_role');

revoke all on table public.application_job_description_versions from anon, authenticated;
grant select on table public.application_job_description_versions to service_role;
revoke all on table public.application_submission_confirmations from anon, authenticated, service_role;
revoke all on table public.application_evidence_snapshots from anon, authenticated, service_role;
revoke all on table public.application_evidence_snapshot_entries from anon, authenticated, service_role;

create or replace function public.create_application_evidence_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_snapshot_id uuid := gen_random_uuid();
  v_as_of timestamptz := statement_timestamp();
  v_total integer;
begin
  select count(*)::integer into v_total from public.job_applications;

  insert into public.application_evidence_snapshots (id, as_of, total_applications)
  values (v_snapshot_id, v_as_of, v_total);

  insert into public.application_evidence_snapshot_entries (snapshot_id, ordinal, application_id, evidence)
  select
    v_snapshot_id,
    row_number() over (order by application.applied_at desc, application.id)::integer,
    application.id,
    jsonb_build_object(
      'application', jsonb_build_object(
        'application_id', application.id,
        'company', application.company,
        'role', application.role,
        'stage', application.stage,
        'applied_at', application.applied_at,
        'created_at', application.created_at,
        'updated_at', application.updated_at,
        'source', application.source,
        'url', application.url,
        'follow_up_date', application.follow_up_date
      ),
      'job_description', case
        when exists (
          select 1 from public.application_job_description_versions jd
          where jd.application_id = application.id
        ) then jsonb_build_object(
          'status', 'versioned',
          'versions', coalesce((
            select jsonb_agg(jsonb_build_object(
              'job_description_version_id', jd.id,
              'content', jd.content,
              'content_hash', jd.content_hash,
              'source_url', jd.source_url,
              'captured_at', jd.captured_at
            ) order by jd.captured_at, jd.id)
            from public.application_job_description_versions jd
            where jd.application_id = application.id
          ), '[]'::jsonb)
        )
        when application.job_description is not null then jsonb_build_object(
          'status', 'legacy_unversioned',
          'versions', '[]'::jsonb,
          'unversioned_content', application.job_description,
          'source_url', application.url
        )
        else jsonb_build_object('status', 'absent', 'versions', '[]'::jsonb)
      end,
      'resume_versions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'resume_id', resume.id,
          'resume_content', resume.resume_content,
          'docx_url', resume.docx_url,
          'docx_hash', resume.docx_hash,
          'pdf_url', resume.pdf_url,
          'pdf_hash', resume.pdf_hash,
          'is_submitted', resume.is_submitted,
          'generated_at', resume.generated_at
        ) order by resume.generated_at, resume.id)
        from public.application_resumes resume
        where resume.application_id = application.id
      ), '[]'::jsonb),
      'score_versions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'score_id', score.id,
          'resume_id', score.resume_id,
          'job_description_version_id', score.job_description_version_id,
          'score_type', score.score_type,
          'score', score.score,
          'rationale', score.rationale,
          'requirement_evidence', score.requirement_evidence,
          'model', score.model,
          'rubric_version', score.rubric_version,
          'rubric_hash', score.rubric_hash,
          'profile_hash', score.profile_hash,
          'scored_at', score.scored_at
        ) order by score.scored_at, score.id)
        from public.application_scores score
        where score.application_id = application.id
      ), '[]'::jsonb),
      'submission_confirmation', case
        when exists (
          select 1 from public.application_submission_confirmations confirmation
          where confirmation.application_id = application.id
        ) then jsonb_build_object(
          'status', 'recorded',
          'confirmations', coalesce((
            select jsonb_agg(jsonb_build_object(
              'submission_confirmation_id', confirmation.id,
              'resume_id', confirmation.resume_id,
              'actual_submission_occurred_at', confirmation.actual_submission_occurred_at,
              'confirmation_recorded_at', confirmation.confirmation_recorded_at,
              'confirmation_source', confirmation.confirmation_source,
              'source_ref', confirmation.source_ref
            ) order by confirmation.confirmation_recorded_at, confirmation.id)
            from public.application_submission_confirmations confirmation
            where confirmation.application_id = application.id
          ), '[]'::jsonb)
        )
        else jsonb_build_object('status', 'unverified', 'confirmations', '[]'::jsonb)
      end,
      'stage_history', coalesce((
        select jsonb_agg(jsonb_build_object(
          'stage_history_id', history.id,
          'stage', history.stage,
          'occurred_at', history.occurred_at
        ) order by history.occurred_at, history.id)
        from public.application_stages history
        where history.application_id = application.id
      ), '[]'::jsonb)
    )
  from public.job_applications application;

  return jsonb_build_object(
    'snapshot_id', v_snapshot_id,
    'as_of', v_as_of,
    'total_applications', v_total,
    'snapshot_materialized', true
  );
end;
$$;

-- Preserve callers of the older three-argument RPC while writing provenance
-- as `unknown`; the six-argument form accepts client-attested timing/source
-- fields. Neither form claims independently observed ATS evidence.
create or replace function public.confirm_application_submission(
  p_application_id uuid,
  p_resume_id uuid,
  p_note text,
  p_actual_submission_occurred_at timestamptz,
  p_confirmation_source text,
  p_source_ref text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_application public.job_applications%rowtype;
  v_resume_id uuid;
begin
  if p_confirmation_source not in ('client_attested', 'unknown') then
    raise exception 'Confirmation source is invalid' using errcode = '22023';
  end if;
  if p_actual_submission_occurred_at is not null
    and p_actual_submission_occurred_at > statement_timestamp() then
    raise exception 'Actual submission time cannot be in the future' using errcode = '22023';
  end if;
  if p_source_ref is not null and length(p_source_ref) > 512 then
    raise exception 'Confirmation source reference is too long' using errcode = '22023';
  end if;

  select * into v_application
  from public.job_applications
  where id = p_application_id
  for update;
  if not found then
    raise exception 'Application not found' using errcode = 'P0001';
  end if;
  if v_application.stage <> 'draft' then
    raise exception 'Only draft applications can be confirmed as submitted' using errcode = 'P0001';
  end if;

  select id into v_resume_id
  from public.application_resumes
  where id = p_resume_id
    and application_id = p_application_id
    and is_submitted = false
  for update;
  if not found then
    raise exception 'Unsubmitted resume evidence not found for application' using errcode = 'P0001';
  end if;

  update public.application_resumes set is_submitted = true where id = v_resume_id;
  update public.job_applications set stage = 'applied', applied_at = statement_timestamp() where id = p_application_id;
  insert into public.application_stages (application_id, stage, note)
  values (p_application_id, 'applied', coalesce(nullif(btrim(p_note), ''), 'Application submission confirmed'));
  insert into public.application_submission_confirmations (
    application_id, resume_id, actual_submission_occurred_at,
    confirmation_recorded_at, confirmation_source, source_ref
  ) values (
    p_application_id, v_resume_id, p_actual_submission_occurred_at,
    statement_timestamp(), p_confirmation_source, nullif(btrim(p_source_ref), '')
  );

  return jsonb_build_object(
    'application_id', p_application_id,
    'resume_id', v_resume_id,
    'company', v_application.company,
    'role', v_application.role,
    'previous_stage', v_application.stage,
    'stage', 'applied'
  );
end;
$$;

create or replace function public.confirm_application_submission(
  p_application_id uuid,
  p_resume_id uuid,
  p_note text default null
) returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.confirm_application_submission($1, $2, $3, null, 'unknown', null);
$$;

create or replace function public.get_application_evidence_snapshot_page(
  p_snapshot_id uuid,
  p_after_ordinal integer default null,
  p_limit integer default 50
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_snapshot public.application_evidence_snapshots%rowtype;
  v_entries jsonb;
  v_returned_count integer;
  v_fetched_count integer;
  v_last_ordinal integer;
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception 'Page limit must be between 1 and 100' using errcode = '22023';
  end if;

  select * into v_snapshot
  from public.application_evidence_snapshots
  where id = p_snapshot_id;
  if not found then
    raise exception 'Evidence snapshot not found' using errcode = 'P0001';
  end if;

  if p_after_ordinal is not null
    and (p_after_ordinal < 0 or p_after_ordinal >= v_snapshot.total_applications) then
    raise exception 'Snapshot cursor is invalid' using errcode = '22023';
  end if;

  with fetched as (
    select entry.ordinal, entry.evidence,
      row_number() over (order by entry.ordinal) as page_position
    from public.application_evidence_snapshot_entries entry
    where entry.snapshot_id = p_snapshot_id
      and entry.ordinal > coalesce(p_after_ordinal, 0)
    order by entry.ordinal
    limit (p_limit + 1)
  )
  select
    coalesce(jsonb_agg(evidence order by ordinal) filter (where page_position <= p_limit), '[]'::jsonb),
    count(*)::integer,
    count(*) filter (where page_position <= p_limit)::integer,
    max(ordinal) filter (where page_position <= p_limit)
  into v_entries, v_fetched_count, v_returned_count, v_last_ordinal
  from fetched;

  return jsonb_build_object(
    'snapshot', jsonb_build_object(
      'snapshot_id', v_snapshot.id,
      'as_of', v_snapshot.as_of,
      'total_applications', v_snapshot.total_applications,
      'snapshot_materialized', true
    ),
    'applications', v_entries,
    'next_cursor', case
      when v_fetched_count > p_limit then jsonb_build_object('ordinal', v_last_ordinal)
      else null
    end,
    'is_final_page', v_fetched_count <= p_limit
  );
end;
$$;

revoke all on function public.create_application_evidence_snapshot() from public;
revoke all on function public.create_application_evidence_snapshot() from anon, authenticated;
grant execute on function public.create_application_evidence_snapshot() to service_role;

revoke all on function public.get_application_evidence_snapshot_page(uuid, integer, integer) from public;
revoke all on function public.get_application_evidence_snapshot_page(uuid, integer, integer) from anon, authenticated;
grant execute on function public.get_application_evidence_snapshot_page(uuid, integer, integer) to service_role;

revoke all on function public.confirm_application_submission(uuid, uuid, text, timestamptz, text, text) from public;
revoke all on function public.confirm_application_submission(uuid, uuid, text, timestamptz, text, text) from anon, authenticated;
grant execute on function public.confirm_application_submission(uuid, uuid, text, timestamptz, text, text) to service_role;

commit;
