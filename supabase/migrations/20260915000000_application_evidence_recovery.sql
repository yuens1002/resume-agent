-- ============================================================
-- Source-owner application evidence recovery
--
-- This is an administrative append path for already-existing application
-- identities. It cannot create an application, mark a resume submitted,
-- change stage, add a score/confirmation/outcome, or invent historical time.
-- Private artifact bytes are verified by the source-owner process before this
-- transaction; the database pins their deterministic paths and SHA-256 hashes.
-- ============================================================

begin;

create table if not exists public.application_resume_recovery_imports (
  recovery_id uuid primary key,
  application_id uuid not null references public.job_applications(id) on delete restrict,
  resume_id uuid not null,
  source_ref text not null check (source_ref ~ '^job-hunt-agent:output:[A-Za-z0-9._-]{1,200}$'),
  resume_content_hash text not null check (resume_content_hash ~ '^[a-f0-9]{64}$'),
  docx_url text,
  docx_hash text check (docx_hash is null or docx_hash ~ '^[a-f0-9]{64}$'),
  pdf_url text,
  pdf_hash text check (pdf_hash is null or pdf_hash ~ '^[a-f0-9]{64}$'),
  -- Historical generator time is deliberately unknown for this recovery path.
  original_generated_at timestamptz,
  recorded_at timestamptz not null default statement_timestamp(),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  unique (application_id, resume_id),
  foreign key (application_id, resume_id)
    references public.application_resumes(application_id, id) on delete restrict,
  check ((docx_url is null) = (docx_hash is null)),
  check ((pdf_url is null) = (pdf_hash is null)),
  check (docx_url is not null or pdf_url is not null),
  check (original_generated_at is null)
);

create index if not exists application_resume_recovery_imports_application_id_recorded_at_idx
  on public.application_resume_recovery_imports(application_id, recorded_at, recovery_id);

alter table public.application_resume_recovery_imports enable row level security;
drop policy if exists "Service role reads recovery imports" on public.application_resume_recovery_imports;
create policy "Service role reads recovery imports" on public.application_resume_recovery_imports
  for select using (auth.role() = 'service_role');
revoke all on table public.application_resume_recovery_imports from public, anon, authenticated;
revoke insert, update, delete on table public.application_resume_recovery_imports from service_role;
grant select on table public.application_resume_recovery_imports to service_role;

create or replace function public.recover_application_resume_version(
  p_recovery_id uuid,
  p_application_id uuid,
  p_expected_company text,
  p_expected_role text,
  p_resume_id uuid,
  p_resume_content jsonb,
  p_docx_url text,
  p_docx_hash text,
  p_pdf_url text,
  p_pdf_hash text,
  p_source_ref text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_application public.job_applications%rowtype;
  v_existing public.application_resume_recovery_imports%rowtype;
  v_existing_resume public.application_resumes%rowtype;
  v_recorded_at timestamptz := statement_timestamp();
  v_resume_content_hash text;
  v_payload jsonb;
  v_payload_hash text;
begin
  if p_resume_content is null or jsonb_typeof(p_resume_content) <> 'object'
    or p_resume_content = '{}'::jsonb
    or pg_catalog.octet_length(p_resume_content::text) > 1048576 then
    raise exception 'Recovered resume content must be a non-empty object' using errcode = '22023';
  end if;
  if p_source_ref !~ '^job-hunt-agent:output:[A-Za-z0-9._-]{1,200}$' then
    raise exception 'Recovery source reference is invalid' using errcode = '22023';
  end if;
  if (p_docx_url is null) <> (p_docx_hash is null)
    or (p_pdf_url is null) <> (p_pdf_hash is null)
    or (p_docx_url is null and p_pdf_url is null)
    or (p_docx_hash is not null and p_docx_hash !~ '^[a-f0-9]{64}$')
    or (p_pdf_hash is not null and p_pdf_hash !~ '^[a-f0-9]{64}$') then
    raise exception 'Recovery artifact references are invalid' using errcode = '22023';
  end if;
  if p_docx_url is not null and p_docx_url <> (p_application_id::text || '/' || p_resume_id::text || '/resume.docx') then
    raise exception 'Recovery DOCX path is not bound to the application and resume' using errcode = '22023';
  end if;
  if p_pdf_url is not null and p_pdf_url <> (p_application_id::text || '/' || p_resume_id::text || '/resume.pdf') then
    raise exception 'Recovery PDF path is not bound to the application and resume' using errcode = '22023';
  end if;

  -- Serialize equal/conflicting retries even when a caller changes the
  -- application ID while reusing a recovery or resume identity.
  perform pg_advisory_xact_lock(hashtextextended(p_recovery_id::text, 151));
  perform pg_advisory_xact_lock(hashtextextended(p_resume_id::text, 152));

  select * into v_application
  from public.job_applications
  where id = p_application_id
  for update;
  if not found then
    raise exception 'Application not found' using errcode = 'P0001';
  end if;
  if v_application.company is distinct from p_expected_company
    or v_application.role is distinct from p_expected_role then
    raise exception 'Application identity does not match recovery manifest' using errcode = '22023';
  end if;

  v_resume_content_hash := encode(pg_catalog.sha256(pg_catalog.convert_to(p_resume_content::text, 'UTF8')), 'hex');
  v_payload := jsonb_build_object(
    'recovery_id', p_recovery_id,
    'application_id', p_application_id,
    'expected_company', p_expected_company,
    'expected_role', p_expected_role,
    'resume_id', p_resume_id,
    'resume_content_hash', v_resume_content_hash,
    'docx_url', p_docx_url,
    'docx_hash', p_docx_hash,
    'pdf_url', p_pdf_url,
    'pdf_hash', p_pdf_hash,
    'source_ref', p_source_ref,
    'original_generated_at', null
  );
  v_payload_hash := encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text, 'UTF8')), 'hex');

  select * into v_existing
  from public.application_resume_recovery_imports
  where recovery_id = p_recovery_id;
  if found then
    select * into v_existing_resume
    from public.application_resumes
    where application_id = v_existing.application_id and id = v_existing.resume_id;
    if found
      and v_existing.application_id = p_application_id
      and v_existing.resume_id = p_resume_id
      and v_existing.source_ref = p_source_ref
      and v_existing.resume_content_hash = v_resume_content_hash
      and v_existing.docx_url is not distinct from p_docx_url
      and v_existing.docx_hash is not distinct from p_docx_hash
      and v_existing.pdf_url is not distinct from p_pdf_url
      and v_existing.pdf_hash is not distinct from p_pdf_hash
      and v_existing.original_generated_at is null
      and v_existing.payload_hash = v_payload_hash
      and v_existing_resume.resume_content = p_resume_content
      and not v_existing_resume.is_submitted then
      return jsonb_build_object(
        'recovery_id', v_existing.recovery_id,
        'application_id', v_existing.application_id,
        'resume_id', v_existing.resume_id,
        'recorded_at', v_existing.recorded_at,
        'idempotent', true
      );
    end if;
    raise exception 'Recovery replay conflicts with existing identity or bytes' using errcode = '22023';
  end if;

  if exists (select 1 from public.application_resumes where id = p_resume_id) then
    raise exception 'Recovery resume identity already exists' using errcode = '22023';
  end if;

  insert into public.application_resumes (
    id, application_id, resume_content, docx_url, docx_hash,
    pdf_url, pdf_hash, is_submitted, generated_at
  ) values (
    p_resume_id, p_application_id, p_resume_content, p_docx_url, p_docx_hash,
    p_pdf_url, p_pdf_hash, false, v_recorded_at
  );
  insert into public.application_resume_recovery_imports (
    recovery_id, application_id, resume_id, source_ref, resume_content_hash,
    docx_url, docx_hash, pdf_url, pdf_hash, original_generated_at,
    recorded_at, payload_hash
  ) values (
    p_recovery_id, p_application_id, p_resume_id, p_source_ref, v_resume_content_hash,
    p_docx_url, p_docx_hash, p_pdf_url, p_pdf_hash, null,
    v_recorded_at, v_payload_hash
  );

  return jsonb_build_object(
    'recovery_id', p_recovery_id,
    'application_id', p_application_id,
    'resume_id', p_resume_id,
    'recorded_at', v_recorded_at,
    'idempotent', false
  );
end;
$$;

revoke all on function public.recover_application_resume_version(uuid,uuid,text,text,uuid,jsonb,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.recover_application_resume_version(uuid,uuid,text,text,uuid,jsonb,text,text,text,text,text)
  to service_role;

-- Replace only the snapshot materializer so future snapshots expose explicit
-- recovery provenance. Existing materialized snapshots remain immutable.
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
  insert into public.application_evidence_snapshots (id, as_of, total_applications)
  values (v_snapshot_id, '-infinity'::timestamptz, 0);

  v_as_of := clock_timestamp();
  with materialized as (
    select
      row_number() over (order by application.created_at, application.id)::integer as ordinal,
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
          when exists (select 1 from public.application_job_description_versions version where version.application_id = application.id) then jsonb_build_object(
            'status', 'versioned',
            'versions', (select jsonb_agg(jsonb_build_object(
              'job_description_version_id', version.id,
              'content', version.content,
              'content_hash', version.content_hash,
              'source_url', version.source_url,
              'captured_at', version.captured_at
            ) order by version.captured_at, version.id) from public.application_job_description_versions version where version.application_id = application.id)
          )
          when application.job_description is not null then jsonb_build_object(
            'status', 'legacy_unversioned', 'versions', '[]'::jsonb,
            'unversioned_content', application.job_description, 'source_url', application.url
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
            'generated_at', resume.generated_at,
            'provenance', case when recovery.recovery_id is null then jsonb_build_object(
              'status', 'recorded_at_write', 'recorded_at', resume.generated_at
            ) else jsonb_build_object(
              'status', 'recovered',
              'recovery_id', recovery.recovery_id,
              'source_ref', recovery.source_ref,
              'recorded_at', recovery.recorded_at,
              'original_generated_at', recovery.original_generated_at,
              'original_generation_time_status', 'unknown'
            ) end
          ) order by resume.generated_at, resume.id)
          from public.application_resumes resume
          left join public.application_resume_recovery_imports recovery
            on recovery.application_id = resume.application_id and recovery.resume_id = resume.id
          where resume.application_id = application.id
        ), '[]'::jsonb),
        'score_versions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'score_id', score.id, 'resume_id', score.resume_id,
            'job_description_version_id', score.job_description_version_id,
            'score_type', score.score_type, 'score', score.score,
            'rationale', score.rationale, 'requirement_evidence', score.requirement_evidence,
            'model', score.model, 'rubric_version', score.rubric_version,
            'rubric_hash', score.rubric_hash, 'profile_hash', score.profile_hash,
            'scored_at', score.scored_at
          ) order by score.scored_at, score.id)
          from public.application_scores score where score.application_id = application.id
        ), '[]'::jsonb),
        'submission_confirmation', case when exists (
          select 1 from public.application_submission_confirmations confirmation where confirmation.application_id = application.id
        ) then jsonb_build_object('status', 'recorded', 'confirmations', (
          select jsonb_agg(jsonb_build_object(
            'submission_confirmation_id', confirmation.id, 'resume_id', confirmation.resume_id,
            'submitted_job_description_version_id', confirmation.submitted_job_description_version_id,
            'submitted_artifact_format', confirmation.submitted_artifact_format,
            'submitted_artifact_hash', confirmation.submitted_artifact_hash,
            'actual_submission_occurred_at', confirmation.actual_submission_occurred_at,
            'confirmation_recorded_at', confirmation.confirmation_recorded_at,
            'confirmation_source', confirmation.confirmation_source, 'source_ref', confirmation.source_ref
          ) order by confirmation.confirmation_recorded_at, confirmation.id)
          from public.application_submission_confirmations confirmation where confirmation.application_id = application.id
        )) else jsonb_build_object('status', 'unverified', 'confirmations', '[]'::jsonb) end,
        'observed_outcomes', coalesce((select jsonb_agg(jsonb_build_object(
          'event_id', outcome.id, 'source_identity', outcome.source_identity,
          'source_event_id', outcome.source_event_id, 'revision', outcome.revision,
          'event_type', outcome.event_type, 'occurred_at', outcome.occurred_at,
          'recorded_at', outcome.recorded_at, 'source_ref', outcome.source_ref,
          'evidence_hash', outcome.evidence_hash, 'classification_code', outcome.classification_code,
          'action_required', outcome.action_required, 'payload_hash', outcome.payload_hash,
          'supersedes_event_id', outcome.supersedes_event_id
        ) order by outcome.source_identity, outcome.source_event_id, outcome.revision)
          from public.application_observed_outcomes outcome where outcome.application_id = application.id), '[]'::jsonb),
        'outcome_checks', coalesce((select jsonb_agg(jsonb_build_object(
          'check_id', coverage.id, 'reader_channel', coverage.reader_channel,
          'client_check_identity', coverage.client_check_identity, 'period_start', coverage.period_start,
          'period_end', coverage.period_end, 'query_scope', coverage.query_scope,
          'application_time_start', coverage.application_time_start, 'complete', coverage.complete,
          'status', coverage.status, 'matched_uid_count', coverage.matched_uid_count,
          'drained_uid_count', coverage.drained_uid_count, 'source_ref', coverage.source_ref,
          'recorded_at', coverage.recorded_at
        ) order by coverage.recorded_at, coverage.id)
          from public.application_outcome_check_observations coverage where coverage.application_id = application.id), '[]'::jsonb),
        'stage_history', coalesce((select jsonb_agg(jsonb_build_object(
          'stage_history_id', stage.id, 'stage', stage.stage, 'occurred_at', stage.occurred_at
        ) order by stage.occurred_at, stage.id) from public.application_stages stage where stage.application_id = application.id), '[]'::jsonb)
      ) as evidence
    from public.job_applications application
    where application.created_at <= v_as_of
  ), inserted as (
    insert into public.application_evidence_snapshot_entries(snapshot_id, ordinal, application_id, evidence)
    select v_snapshot_id, ordinal, application_id, evidence from materialized order by ordinal
    returning 1
  )
  select count(*)::integer into v_total from inserted;

  update public.application_evidence_snapshots
  set as_of = v_as_of, total_applications = v_total
  where id = v_snapshot_id;
  return jsonb_build_object(
    'snapshot_id', v_snapshot_id, 'as_of', v_as_of,
    'total_applications', v_total, 'snapshot_materialized', true
  );
end;
$$;

commit;
