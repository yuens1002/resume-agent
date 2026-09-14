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
  capture_operation_id uuid,
  captured_at     timestamptz not null default statement_timestamp(),
  created_at      timestamptz not null default now()
);

create index if not exists application_job_description_versions_application_id_captured_at_idx
  on application_job_description_versions (application_id, captured_at, id);

-- This backs the composite score FK below, ensuring a score cannot point at a
-- JD version from some other application.
create unique index if not exists application_job_description_versions_application_id_id_idx
  on application_job_description_versions (application_id, id);

alter table public.job_applications
  add column if not exists job_description_capture_operation_id uuid;
alter table public.application_job_description_versions
  add column if not exists capture_operation_id uuid;
create unique index if not exists application_job_description_versions_capture_operation_idx
  on public.application_job_description_versions (application_id, capture_operation_id)
  where capture_operation_id is not null;

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
      application_id, content, content_hash, source_url, capture_operation_id, captured_at
    ) values (
      new.id,
      new.job_description,
      encode(digest(convert_to(new.job_description, 'UTF8'), 'sha256'), 'hex'),
      new.url,
      case
        when tg_op = 'UPDATE' and new.job_description_capture_operation_id is not distinct from old.job_description_capture_operation_id
          then gen_random_uuid()
        else new.job_description_capture_operation_id
      end,
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
  submitted_job_description_version_id uuid,
  submitted_artifact_format   text check (submitted_artifact_format in ('docx', 'pdf')),
  submitted_artifact_hash     text,
  actual_submission_occurred_at timestamptz,
  confirmation_recorded_at    timestamptz not null default statement_timestamp(),
  confirmation_source         text        not null check (confirmation_source in ('client_attested', 'unknown')),
  source_ref                  text,
  created_at                  timestamptz not null default now(),
  unique (application_id, resume_id),
  foreign key (application_id, resume_id)
    references public.application_resumes (application_id, id)
    on delete cascade,
  foreign key (application_id, submitted_job_description_version_id)
    references public.application_job_description_versions (application_id, id)
    on delete set null (submitted_job_description_version_id)
);

create index if not exists application_submission_confirmations_application_id_recorded_at_idx
  on public.application_submission_confirmations (application_id, confirmation_recorded_at, id);

create table if not exists public.application_observed_outcomes (
  id uuid primary key default gen_random_uuid(),
  -- Outcome history is immutable audit evidence. A supported application
  -- deletion must explicitly reconcile it rather than silently erasing it.
  application_id uuid not null references public.job_applications(id) on delete restrict,
  source_identity text not null check (source_identity = 'granted_inbox'),
  -- Opaque mailbox hash + UIDVALIDITY + UID: never a Message-ID, address, or
  -- raw mail content, and stable across IMAP UID resets/accounts.
  source_event_id text not null check (source_event_id ~ '^imap:[a-f0-9]{64}:[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$'),
  revision integer not null check (revision > 0),
  event_type text not null check (event_type in ('recruiter_contact', 'screen_scheduled', 'screen_held', 'interview_scheduled', 'interview_held', 'cancellation', 'rejection', 'withdrawal', 'offer', 'offer_accepted', 'job_started', 'other_response')),
  occurred_at timestamptz,
  recorded_at timestamptz not null default statement_timestamp(),
  source_ref text not null check (source_ref ~ '^imap:[a-f0-9]{64}:[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$'),
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  classification_code text not null check (classification_code in ('automated_ack', 'explicit_email_content', 'ambiguous_email_content', 'unclassified')),
  action_required boolean,
  supersedes_event_id uuid references public.application_observed_outcomes(id),
  canonical_payload jsonb not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  unique (application_id, source_identity, source_event_id, revision)
);

create table if not exists public.application_outcome_check_observations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.job_applications(id) on delete restrict,
  reader_channel text not null check (reader_channel = 'imap_inbox'),
  client_check_identity text not null check (length(client_check_identity) between 1 and 512),
  period_start timestamptz not null,
  period_end timestamptz not null,
  query_scope text not null check (query_scope = 'inbox_internaldate_v1'),
  application_time_start timestamptz,
  complete boolean not null,
  status text not null check (status in ('observed', 'no_response', 'unknown')),
  matched_uid_count integer not null check (matched_uid_count >= 0),
  drained_uid_count integer not null check (drained_uid_count >= 0),
  -- An opaque producer receipt, not a claim that every response channel was
  -- searched. Its mailbox tuple/time/count binding is validated by the RPC.
  source_ref text not null check (source_ref ~ '^imap-coverage:[a-f0-9]{64}:[1-9][0-9]{0,9}:[0-9]{1,13}:[0-9]{1,10}:[0-9]{1,10}$'),
  canonical_payload jsonb not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz not null default statement_timestamp(),
  unique (application_id, reader_channel, client_check_identity)
);

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
alter table public.application_observed_outcomes enable row level security;
alter table public.application_outcome_check_observations enable row level security;
alter table public.application_evidence_snapshots enable row level security;
alter table public.application_evidence_snapshot_entries enable row level security;

drop policy if exists "Service role full access" on public.application_job_description_versions;
create policy "Service role full access" on public.application_job_description_versions
  for all using (auth.role() = 'service_role');

drop policy if exists "Service role full access" on public.application_submission_confirmations;
create policy "Service role full access" on public.application_submission_confirmations
  for select using (auth.role() = 'service_role');
drop policy if exists "Service role full access" on public.application_observed_outcomes;
create policy "Service role full access" on public.application_observed_outcomes
  for select using (auth.role() = 'service_role');
drop policy if exists "Service role full access" on public.application_outcome_check_observations;
create policy "Service role full access" on public.application_outcome_check_observations
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
revoke all on table public.application_observed_outcomes from anon, authenticated, service_role;
revoke all on table public.application_outcome_check_observations from anon, authenticated, service_role;
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
  v_as_of timestamptz;
  v_total integer;
begin
  -- This provisional row is never visible outside this function's transaction.
  -- The source relation and final `as_of` are set together below in one SQL
  -- statement, so READ COMMITTED cannot combine a later source row with an
  -- earlier declared timestamp.
  insert into public.application_evidence_snapshots (id, as_of, total_applications)
  values (v_snapshot_id, '-infinity'::timestamptz, 0);

  with snapshot_boundary as materialized (
    select statement_timestamp() as as_of
  ), source_rows as materialized (
    select
      row_number() over (order by application.applied_at desc, application.id)::integer as ordinal,
      application.id as application_id,
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
          'follow_up_date', application.follow_up_date,
          'fit_score', application.fit_score,
          'match_verdict', application.match_verdict,
          'match_scoring', application.match_scoring,
          'recommended_action', application.recommended_action
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
                'submitted_job_description_version_id', confirmation.submitted_job_description_version_id,
                'submitted_artifact_format', confirmation.submitted_artifact_format,
                'submitted_artifact_hash', confirmation.submitted_artifact_hash,
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
        'observed_outcomes', coalesce((
          select jsonb_agg(jsonb_build_object(
            'event_id', outcome.id,
            'source_identity', outcome.source_identity,
            'source_event_id', outcome.source_event_id,
            'revision', outcome.revision,
            'event_type', outcome.event_type,
            'occurred_at', outcome.occurred_at,
            'recorded_at', outcome.recorded_at,
            'source_ref', outcome.source_ref,
            'evidence_hash', outcome.evidence_hash,
            'classification_code', outcome.classification_code,
            'action_required', outcome.action_required,
            'payload_hash', outcome.payload_hash,
            'supersedes_event_id', outcome.supersedes_event_id
          ) order by outcome.recorded_at, outcome.id)
          from public.application_observed_outcomes outcome where outcome.application_id = application.id
        ), '[]'::jsonb),
        'outcome_checks', coalesce((
          select jsonb_agg(jsonb_build_object(
            'check_id', outcome_check.id,
            'reader_channel', outcome_check.reader_channel,
            'client_check_identity', outcome_check.client_check_identity,
            'period_start', outcome_check.period_start,
            'period_end', outcome_check.period_end,
            'query_scope', outcome_check.query_scope,
            'application_time_start', outcome_check.application_time_start,
            'complete', outcome_check.complete,
            'status', outcome_check.status,
            'matched_uid_count', outcome_check.matched_uid_count,
            'drained_uid_count', outcome_check.drained_uid_count,
            'source_ref', outcome_check.source_ref,
            'recorded_at', outcome_check.recorded_at
          ) order by outcome_check.recorded_at, outcome_check.id)
          from public.application_outcome_check_observations outcome_check where outcome_check.application_id = application.id
        ), '[]'::jsonb),
        'stage_history', coalesce((
          select jsonb_agg(jsonb_build_object(
            'stage_history_id', history.id,
            'stage', history.stage,
            'occurred_at', history.occurred_at
          ) order by history.occurred_at, history.id)
          from public.application_stages history
          where history.application_id = application.id
        ), '[]'::jsonb)
      ) as evidence
    from public.job_applications application
    cross join snapshot_boundary
  ), inserted_entries as (
    insert into public.application_evidence_snapshot_entries (snapshot_id, ordinal, application_id, evidence)
    select v_snapshot_id, ordinal, application_id, evidence
    from source_rows
    returning 1
  ), updated_snapshot as (
    update public.application_evidence_snapshots
    set as_of = (select as_of from snapshot_boundary),
        total_applications = (select count(*)::integer from inserted_entries)
    where id = v_snapshot_id
    returning as_of, total_applications
  )
  select as_of, total_applications into v_as_of, v_total
  from updated_snapshot;

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
  p_source_ref text,
  p_submitted_job_description_version_id uuid default null,
  p_submitted_artifact_format text default null,
  p_submitted_artifact_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_application public.job_applications%rowtype;
  v_resume_id uuid;
  v_selected_artifact_hash text;
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
  if p_submitted_artifact_format is not null and p_submitted_artifact_format not in ('docx', 'pdf') then
    raise exception 'Submitted artifact format is invalid' using errcode = '22023';
  end if;
  if (p_submitted_artifact_format is null) <> (p_submitted_artifact_hash is null) then
    raise exception 'Submitted artifact format and hash must be supplied together' using errcode = '22023';
  end if;
  if p_submitted_artifact_hash is not null and p_submitted_artifact_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Submitted artifact hash is invalid' using errcode = '22023';
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
  if p_submitted_artifact_format = 'docx' then
    select docx_hash into v_selected_artifact_hash
    from public.application_resumes where id = v_resume_id;
  elsif p_submitted_artifact_format = 'pdf' then
    select pdf_hash into v_selected_artifact_hash
    from public.application_resumes where id = v_resume_id;
  end if;
  if p_submitted_artifact_format is not null and v_selected_artifact_hash is distinct from p_submitted_artifact_hash then
    raise exception 'Submitted artifact hash does not match the selected resume' using errcode = '22023';
  end if;

  update public.application_resumes set is_submitted = true where id = v_resume_id;
  update public.job_applications set stage = 'applied', applied_at = statement_timestamp() where id = p_application_id;
  insert into public.application_stages (application_id, stage, note)
  values (p_application_id, 'applied', coalesce(nullif(btrim(p_note), ''), 'Application submission confirmed'));
  insert into public.application_submission_confirmations (
    application_id, resume_id, submitted_job_description_version_id, submitted_artifact_format, submitted_artifact_hash, actual_submission_occurred_at,
    confirmation_recorded_at, confirmation_source, source_ref
  ) values (
    p_application_id, v_resume_id, p_submitted_job_description_version_id, p_submitted_artifact_format, p_submitted_artifact_hash, p_actual_submission_occurred_at,
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
  select public.confirm_application_submission($1, $2, $3, null, 'unknown', null, null, null, null);
$$;

create or replace function public.record_application_observed_outcome(
  p_application_id uuid, p_source_identity text, p_source_event_id text,
  p_revision integer, p_event_type text, p_occurred_at timestamptz,
  p_source_ref text, p_evidence_hash text, p_classification_code text,
  p_action_required boolean, p_supersedes_event_id uuid
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_existing public.application_observed_outcomes%rowtype; v_prior public.application_observed_outcomes%rowtype; v_recorded_at timestamptz := statement_timestamp(); v_id uuid := gen_random_uuid(); v_payload_hash text; v_payload jsonb;
begin
  if p_source_identity <> 'granted_inbox' or p_event_type not in ('recruiter_contact', 'screen_scheduled', 'screen_held', 'interview_scheduled', 'interview_held', 'cancellation', 'rejection', 'withdrawal', 'offer', 'offer_accepted', 'job_started', 'other_response') then raise exception 'Outcome source or type is invalid' using errcode = '22023'; end if;
  if p_source_event_id !~ '^imap:[a-f0-9]{64}:[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$' or p_source_ref is distinct from p_source_event_id then raise exception 'Outcome source reference is invalid' using errcode = '22023'; end if;
  if p_evidence_hash !~ '^[a-f0-9]{64}$' or p_classification_code not in ('automated_ack', 'explicit_email_content', 'ambiguous_email_content', 'unclassified') then raise exception 'Outcome evidence classification is invalid' using errcode = '22023'; end if;
  if (p_event_type in ('offer_accepted','job_started') or p_action_required is false) and p_classification_code <> 'explicit_email_content' then raise exception 'Outcome requires explicit attributed email evidence' using errcode = '22023'; end if;
  if p_occurred_at is not null and p_occurred_at > v_recorded_at then raise exception 'Outcome occurrence cannot be after source recording time' using errcode = '22023'; end if;
  -- Canonical server calculation prevents a caller from claiming idempotency
  -- with a stale digest for changed event content.
  v_payload := jsonb_build_object(
    'application_id', p_application_id, 'source_identity', p_source_identity,
    'source_event_id', p_source_event_id, 'revision', p_revision,
    'event_type', p_event_type, 'occurred_at', p_occurred_at,
    'source_ref', p_source_ref, 'evidence_hash', p_evidence_hash,
    'classification_code', p_classification_code,
    'action_required', p_action_required,
    'supersedes_event_id', p_supersedes_event_id
  );
  v_payload_hash := encode(digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');
  if p_revision = 1 and p_supersedes_event_id is not null then raise exception 'Initial outcome revision cannot supersede an event' using errcode = '22023'; end if;
  if p_revision > 1 then
    select * into v_prior from public.application_observed_outcomes where id=p_supersedes_event_id and application_id=p_application_id and source_identity=p_source_identity and source_event_id=p_source_event_id and revision=p_revision-1;
    if not found then raise exception 'Outcome correction predecessor is invalid' using errcode = '22023'; end if;
  end if;
  insert into public.application_observed_outcomes (id, application_id, source_identity, source_event_id, revision, event_type, occurred_at, recorded_at, source_ref, evidence_hash, classification_code, action_required, supersedes_event_id, canonical_payload, payload_hash)
  values (v_id,p_application_id,p_source_identity,p_source_event_id,p_revision,p_event_type,p_occurred_at,v_recorded_at,p_source_ref,p_evidence_hash,p_classification_code,p_action_required,p_supersedes_event_id,v_payload,v_payload_hash)
  on conflict (application_id, source_identity, source_event_id, revision) do nothing
  returning id, recorded_at into v_id, v_recorded_at;
  if found then return jsonb_build_object('event_id',v_id,'recorded_at',v_recorded_at,'idempotent',false); end if;
  select * into v_existing from public.application_observed_outcomes where application_id=p_application_id and source_identity=p_source_identity and source_event_id=p_source_event_id and revision=p_revision;
  if v_existing.canonical_payload = v_payload then return jsonb_build_object('event_id', v_existing.id, 'recorded_at', v_existing.recorded_at, 'idempotent', true); end if;
  raise exception 'Outcome replay conflicts with existing source identity and revision' using errcode = '22023';
end;
$$;

create or replace function public.record_application_outcome_check(
  p_application_id uuid, p_reader_channel text, p_client_check_identity text,
  p_period_start timestamptz, p_period_end timestamptz, p_query_scope text,
  p_application_time_start timestamptz, p_complete boolean, p_status text,
  p_matched_uid_count integer, p_drained_uid_count integer, p_source_ref text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_existing public.application_outcome_check_observations%rowtype; v_id uuid := gen_random_uuid(); v_recorded_at timestamptz := statement_timestamp(); v_payload_hash text; v_payload jsonb; v_ref_parts text[];
begin
  if p_reader_channel <> 'imap_inbox' or p_status not in ('observed','no_response','unknown') or p_query_scope <> 'inbox_internaldate_v1' or p_period_start > p_period_end or p_period_end > v_recorded_at or p_matched_uid_count < 0 or p_drained_uid_count < 0 then raise exception 'Outcome coverage is invalid' using errcode = '22023'; end if;
  v_ref_parts := regexp_match(p_source_ref, '^imap-coverage:([a-f0-9]{64}):([1-9][0-9]{0,9}):([0-9]{1,13}):([0-9]{1,10}):([0-9]{1,10})$');
  if v_ref_parts is null or v_ref_parts[3] <> floor(extract(epoch from p_period_end) * 1000)::bigint::text or v_ref_parts[4] <> p_matched_uid_count::text or v_ref_parts[5] <> p_drained_uid_count::text then raise exception 'Outcome coverage receipt is invalid' using errcode = '22023'; end if;
  v_payload := jsonb_build_object(
    'application_id', p_application_id, 'reader_channel', p_reader_channel,
    'client_check_identity', p_client_check_identity, 'period_start', p_period_start,
    'period_end', p_period_end, 'query_scope', p_query_scope,
    'application_time_start', p_application_time_start, 'complete', p_complete,
    'status', p_status, 'matched_uid_count', p_matched_uid_count,
    'drained_uid_count', p_drained_uid_count, 'source_ref', p_source_ref
  );
  v_payload_hash := encode(digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');
  if p_status='no_response' and (not p_complete or p_matched_uid_count <> p_drained_uid_count or p_application_time_start is null or p_period_start > p_application_time_start or p_period_end < p_application_time_start or not exists (select 1 from public.application_submission_confirmations confirmation where confirmation.application_id=p_application_id and confirmation.confirmation_source='client_attested' and confirmation.actual_submission_occurred_at=p_application_time_start)) then raise exception 'No-response coverage lacks complete attributed submission evidence' using errcode = '22023'; end if;
  insert into public.application_outcome_check_observations (id,application_id,reader_channel,client_check_identity,period_start,period_end,query_scope,application_time_start,complete,status,matched_uid_count,drained_uid_count,source_ref,canonical_payload,payload_hash,recorded_at)
  values (v_id,p_application_id,p_reader_channel,p_client_check_identity,p_period_start,p_period_end,p_query_scope,p_application_time_start,p_complete,p_status,p_matched_uid_count,p_drained_uid_count,p_source_ref,v_payload,v_payload_hash,v_recorded_at)
  on conflict (application_id, reader_channel, client_check_identity) do nothing
  returning id, recorded_at into v_id, v_recorded_at;
  if found then return jsonb_build_object('check_id',v_id,'recorded_at',v_recorded_at,'idempotent',false); end if;
  select * into v_existing from public.application_outcome_check_observations where application_id=p_application_id and reader_channel=p_reader_channel and client_check_identity=p_client_check_identity;
  if v_existing.canonical_payload=v_payload then return jsonb_build_object('check_id',v_existing.id,'recorded_at',v_existing.recorded_at,'idempotent',true); end if;
  raise exception 'Outcome coverage replay conflicts with existing identity' using errcode = '22023';
end;
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

revoke all on function public.confirm_application_submission(uuid, uuid, text, timestamptz, text, text, uuid, text, text) from public;
revoke all on function public.confirm_application_submission(uuid, uuid, text, timestamptz, text, text, uuid, text, text) from anon, authenticated;
grant execute on function public.confirm_application_submission(uuid, uuid, text, timestamptz, text, text, uuid, text, text) to service_role;

revoke all on function public.record_application_observed_outcome(uuid,text,text,integer,text,timestamptz,text,text,text,boolean,uuid) from public, anon, authenticated;
grant execute on function public.record_application_observed_outcome(uuid,text,text,integer,text,timestamptz,text,text,text,boolean,uuid) to service_role;
revoke all on function public.record_application_outcome_check(uuid,text,text,timestamptz,timestamptz,text,timestamptz,boolean,text,integer,integer,text) from public, anon, authenticated;
grant execute on function public.record_application_outcome_check(uuid,text,text,timestamptz,timestamptz,text,timestamptz,boolean,text,integer,integer,text) to service_role;

commit;
