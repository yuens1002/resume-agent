-- ============================================================
-- purge_resume_evidence: add WHERE clauses so pg_safeupdate accepts the
-- DELETEs over PostgREST
--
-- Supabase loads the pg_safeupdate extension for API (PostgREST) requests,
-- which rejects any DELETE or UPDATE statement with no WHERE clause — even
-- one running inside a SECURITY DEFINER function invoked via the RPC
-- endpoint. 20261002120000_purge_resume_evidence.sql's apply branch has five
-- unqualified DELETEs (every row in a table, by design — see that
-- migration's header), so calling purge_resume_evidence(p_apply => true, ...)
-- through PostgREST failed in production with "DELETE requires a WHERE
-- clause" before a single row was removed.
--
-- This is a `create or replace` of the identical function body with `where
-- true` added to each unqualified DELETE. `where true` matches every row,
-- same as no WHERE at all, so behaviour is byte-for-byte unchanged — this
-- satisfies pg_safeupdate's syntactic check without changing which rows are
-- removed. The two statements that already carry a real WHERE clause
-- (the `application_outcome_check_observations` delete and the
-- `job_applications` draft delete) and the one UPDATE (promoting a draft)
-- are untouched; they already pass pg_safeupdate.
--
-- Everything else — the header's FK-order reasoning, the promotion logic,
-- the locks, the dry-run/apply gating, the returned report shape — is
-- unchanged from 20261002120000. See that migration for the full rationale.
-- ============================================================

begin;

create or replace function public.purge_resume_evidence(
  p_apply boolean default false,
  p_expected_drafts integer default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_draft_count integer;
  v_promote_ids uuid[];
  v_promote_count integer;
  v_delete_count integer;
  v_outcome_checks_count integer;
  v_confirmations_count integer;
  v_recovery_import_count integer;
  v_resume_count integer;
  v_nullable_score_count integer;
  v_snapshot_entry_count integer;
  v_snapshot_count integer;
  v_blocking_observed_outcomes integer;
  v_removed_confirmations integer := 0;
  v_removed_recovery_imports integer := 0;
  v_removed_outcome_checks integer := 0;
  v_removed_resumes integer := 0;
  v_removed_drafts integer := 0;
  v_removed_snapshot_entries integer := 0;
  v_removed_snapshots integer := 0;
  v_promoted integer := 0;
begin
  if p_apply and p_expected_drafts is null then
    raise exception 'expected_drafts is required when applying the purge' using errcode = '22023';
  end if;

  -- A dry run (or an apply) must never hang indefinitely behind a long
  -- concurrent transaction holding one of the locks below — surface it as
  -- an ordinary error instead.
  set local lock_timeout = '5s';

  -- Held for the rest of this call (a single top-level statement), so a
  -- concurrent writer cannot change the counts this checks against between
  -- the read and the delete/promote below.
  lock table public.job_applications in share row exclusive mode;
  lock table public.application_resumes in share row exclusive mode;
  lock table public.application_evidence_snapshots in share row exclusive mode;
  lock table public.application_evidence_snapshot_entries in share row exclusive mode;

  select count(*) into v_draft_count from public.job_applications where stage = 'draft';

  -- Promotion set: every draft with at least one recorded reply outcome.
  select coalesce(array_agg(distinct application_id), array[]::uuid[]) into v_promote_ids
  from public.application_observed_outcomes
  where application_id in (select id from public.job_applications where stage = 'draft');
  v_promote_count := coalesce(array_length(v_promote_ids, 1), 0);
  v_delete_count := v_draft_count - v_promote_count;

  select count(*) into v_outcome_checks_count
  from public.application_outcome_check_observations
  where application_id in (select id from public.job_applications where stage = 'draft')
    and application_id <> all (v_promote_ids);

  select count(*) into v_confirmations_count from public.application_submission_confirmations;
  select count(*) into v_recovery_import_count from public.application_resume_recovery_imports;
  select count(*) into v_resume_count from public.application_resumes;
  select count(*) into v_nullable_score_count from public.application_scores where resume_id is not null;
  select count(*) into v_snapshot_entry_count from public.application_evidence_snapshot_entries;
  select count(*) into v_snapshot_count from public.application_evidence_snapshots;

  -- Defensive only — see header comment. Always 0 by construction; this
  -- guards a future logic change rather than a normal code path.
  select count(*) into v_blocking_observed_outcomes
  from public.application_observed_outcomes
  where application_id in (select id from public.job_applications where stage = 'draft')
    and application_id <> all (v_promote_ids);

  if p_apply then
    if p_expected_drafts <> v_delete_count then
      raise exception 'Draft-to-delete count mismatch: expected % but found % (% draft(s) will be promoted instead of deleted) — re-run the dry run and pass the current count',
        p_expected_drafts, v_delete_count, v_promote_count
        using errcode = '22023';
    end if;
    if v_blocking_observed_outcomes > 0 then
      raise exception 'Purge refused: % observed outcome row(s) remain attached to a draft marked for deletion; resolve manually before retrying',
        v_blocking_observed_outcomes
        using errcode = 'P0001';
    end if;

    -- Promotion changes stage and appends one stage-history row only;
    -- applied_at is deliberately left untouched (this is a bookkeeping
    -- correction, not a new submission event).
    update public.job_applications
    set stage = 'applied'
    where id = any (v_promote_ids) and stage = 'draft';
    get diagnostics v_promoted = row_count;

    insert into public.application_stages (application_id, stage, note)
    select promoted_id, 'applied', 'Promoted from draft: a reply outcome was recorded'
    from unnest(v_promote_ids) as promoted_id;

    -- Materialized evidence snapshots copy resume content/hashes and
    -- confirmation data independently of the source rows below — entries
    -- before their parent snapshot, though the FK is already CASCADE.
    delete from public.application_evidence_snapshot_entries where true;
    get diagnostics v_removed_snapshot_entries = row_count;

    delete from public.application_evidence_snapshots where true;
    get diagnostics v_removed_snapshots = row_count;

    delete from public.application_submission_confirmations where true;
    get diagnostics v_removed_confirmations = row_count;

    delete from public.application_resume_recovery_imports where true;
    get diagnostics v_removed_recovery_imports = row_count;

    delete from public.application_outcome_check_observations
    where application_id in (select id from public.job_applications where stage = 'draft')
      and application_id <> all (v_promote_ids);
    get diagnostics v_removed_outcome_checks = row_count;

    delete from public.application_resumes where true;
    get diagnostics v_removed_resumes = row_count;

    delete from public.job_applications
    where stage = 'draft' and id <> all (v_promote_ids);
    get diagnostics v_removed_drafts = row_count;
  end if;

  return jsonb_build_object(
    'mode', case when p_apply then 'apply' else 'dry_run' end,
    'applied', p_apply,
    'draft_count', v_draft_count,
    'promote_count', case when p_apply then v_promoted else v_promote_count end,
    'delete_count', case when p_apply then v_removed_drafts else v_delete_count end,
    'blocking', jsonb_build_object(
      'draft_observed_outcomes_remaining', v_blocking_observed_outcomes
    ),
    'counts', jsonb_build_object(
      'application_submission_confirmations', case when p_apply then v_removed_confirmations else v_confirmations_count end,
      'application_resume_recovery_imports', case when p_apply then v_removed_recovery_imports else v_recovery_import_count end,
      'application_outcome_check_observations', case when p_apply then v_removed_outcome_checks else v_outcome_checks_count end,
      'application_resumes', case when p_apply then v_removed_resumes else v_resume_count end,
      'application_evidence_snapshot_entries', case when p_apply then v_removed_snapshot_entries else v_snapshot_entry_count end,
      'application_evidence_snapshots', case when p_apply then v_removed_snapshots else v_snapshot_count end,
      'application_scores_resume_id_to_null', v_nullable_score_count
    )
  );
end;
$$;

revoke all on function public.purge_resume_evidence(boolean, integer) from public;
revoke all on function public.purge_resume_evidence(boolean, integer) from anon, authenticated;
grant execute on function public.purge_resume_evidence(boolean, integer) to service_role;

commit;
