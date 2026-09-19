-- ============================================================
-- Application evidence snapshot retention (#285)
--
-- Every call to create_application_evidence_snapshot() materializes the full
-- evidence for every application, and nothing ever deleted an old snapshot, so
-- a consumer polling the creator on a schedule grew
-- application_evidence_snapshot_entries without bound. This migration bounds
-- storage inside the server rather than depending on any caller's cadence:
--
-- - application_evidence_snapshot_retention() is the single definition of the
--   retention window. The creator and the tests read it by name; nothing else
--   restates its value.
-- - create_application_evidence_snapshot() first deletes every snapshot whose
--   created_at is older than now() minus that window, in the same transaction
--   as the new snapshot. Entries go with it through the existing
--   application_evidence_snapshot_entries.snapshot_id ON DELETE CASCADE.
--   The rest of the function body is carried over unchanged from
--   20260915000000_application_evidence_recovery.sql.
--
-- A pruned snapshot ID already refuses with P0001 from
-- get_application_evidence_snapshot_page (snapshot_not_found at the MCP tool),
-- so the page contract does not change. A reader must finish paging a
-- snapshot inside the window.
--
-- Space already held by past snapshots is reclaimed by a separate, post-deploy
-- VACUUM FULL, not here: it cannot run inside a transaction and takes an
-- exclusive lock.
-- ============================================================

begin;

create or replace function public.application_evidence_snapshot_retention()
returns interval
language sql
immutable
set search_path = pg_catalog
as $$
  select interval '24 hours'
$$;

revoke all on function public.application_evidence_snapshot_retention() from public, anon, authenticated;
grant execute on function public.application_evidence_snapshot_retention() to service_role;

-- How many expired snapshots one create call may prune. Defined once, beside
-- the window, so tests and operators read both by name.
create or replace function public.application_evidence_snapshot_prune_batch()
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select 5
$$;

revoke all on function public.application_evidence_snapshot_prune_batch() from public, anon, authenticated;
grant execute on function public.application_evidence_snapshot_prune_batch() to service_role;

-- The page reader is re-declared STABLE so its snapshot lookup and its entries
-- lookup share one snapshot of the database. While it was VOLATILE, each
-- statement took its own, so a prune committing between them could return the
-- snapshot's metadata with an empty final page instead of the documented
-- snapshot_not_found refusal. The body is unchanged; only the volatility is.
alter function public.get_application_evidence_snapshot_page(uuid, integer, integer) stable;

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
  -- Retention: drop snapshots created before the window, entries cascade.
  -- created_at (not as_of) is the age: it is the row default stamped at
  -- transaction start, which is the creation time the docs describe, and it
  -- differs from the reader-visible as_of only by the materialization time.
  --
  -- Bounded per call, because an unbounded prune would make the first call
  -- after deploy delete the whole backlog in the same transaction as a full
  -- materialization. Any client abort (this repo's own fetch timeout among
  -- them) would roll that back and the next call would repeat it, so the
  -- backlog would never drain. At one expired snapshot per call in steady
  -- state this is slack; a backlog drains over the next few calls.
  delete from public.application_evidence_snapshots
  where id in (
    select id
    from public.application_evidence_snapshots
    where created_at < now() - public.application_evidence_snapshot_retention()
    order by created_at
    limit public.application_evidence_snapshot_prune_batch()
  );

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

-- Unchanged from 20260914000000_application_evidence_snapshot.sql: callable by
-- service_role only. Restated so this migration is self-evidently safe under
-- the security-definer grants audit.
revoke all on function public.create_application_evidence_snapshot() from public;
revoke all on function public.create_application_evidence_snapshot() from anon, authenticated;
grant execute on function public.create_application_evidence_snapshot() to service_role;

commit;
