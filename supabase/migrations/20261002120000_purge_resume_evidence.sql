-- ============================================================
-- One-time resume-evidence purge
--
-- The server now records submitted applications only (#308) — no drafts, no
-- resume content, no files. This closes the gap for data that predates that
-- change: existing draft applications, every application_resumes row
-- (including ones already marked submitted), and every materialized
-- evidence snapshot still hold resume content/file references the server
-- should no longer keep. `scripts/purge-resume-evidence.ts` drives this
-- function; it is a one-time administrative operation, not a path any MCP
-- tool or regular writer calls.
--
-- A draft is not always abandoned scaffolding. Production has drafts with a
-- recorded application_observed_outcomes row — a real reply was observed
-- against that application id, which only happens for a real submission
-- confirm_application_submission was never called to confirm. Deleting such
-- a draft would destroy the one piece of independent evidence (the reply)
-- that it was ever sent. So this function PROMOTES any draft that has at
-- least one application_observed_outcomes row — stage becomes 'applied' and
-- one application_stages row is appended — instead of deleting it. Its
-- outcomes and outcome-check rows are untouched: a promoted application is a
-- kept application. Promotion changes stage only — applied_at is left as it
-- was, since this is a bookkeeping correction, not a submission event, and
-- the application's real applied_at (if any) predates this run. Every other
-- draft is deleted as before.
--
-- What this function removes, and why each table lands where it does:
--
--   application_evidence_snapshot_entries, then application_evidence_snapshots
--   — ALL rows, deleted first, entries before their parent. A materialized
--   snapshot entry copies resume_content, docx/pdf urls and hashes, and
--   submission-confirmation data straight out of application_resumes and
--   application_submission_confirmations at the time it was created — it is
--   resume evidence in its own right, independent of whether the source rows
--   below still exist. The reply-matching MCP client that reads these simply
--   creates a fresh snapshot (empty of resume evidence, same as every other
--   snapshot taken after this run) on its next call — there is nothing to
--   reconcile. entries' FK to snapshots is ON DELETE CASCADE, so deleting it
--   first is belt-and-suspenders, not strictly required, but explicit beats
--   implicit for a delete this irreversible, same reasoning as every other
--   table here. Neither table has any FK onto a job_applications or
--   application_resumes row — application ids inside the materialized
--   `evidence` jsonb are just data — so removing them never touches, and
--   cannot be blocked by, any application table.
--
--   application_submission_confirmations — ALL rows, deleted next. This is
--   resume evidence (an attestation tied to one exact resume_id), and the
--   operator has copied every sent resume elsewhere before running this
--   (see the README). Deleted before application_resumes so its composite
--   ON DELETE CASCADE FK onto application_resumes never has to fire —
--   explicit beats implicit for a delete this irreversible.
--
--   application_resume_recovery_imports — ALL rows, deleted next. This table
--   exists only to record the hash/path provenance of a recovered resume
--   artifact; it is resume evidence with no independent audit value, and its
--   composite FK to application_resumes is ON DELETE RESTRICT, so it must go
--   before application_resumes or it blocks every row in that table.
--
--   application_outcome_check_observations — rows attached to a draft that
--   will be DELETED (i.e. not promoted) are removed next. These rows record
--   only whether a reply had arrived by some check time, not that one did;
--   a check-observation with no positive outcome carries no evidence a
--   deleted draft was ever real, so it is not promotion-worthy on its own.
--   Its FK to job_applications is ON DELETE RESTRICT, so it must go before
--   the draft rows below. Rows on a PROMOTED draft are untouched — a
--   promoted application is kept, and so is everything already attached to
--   it.
--
--   application_resumes — ALL rows, every application, applied and promoted
--   ones included. This is the actual deliverable: no resume content or
--   file reference stays on the server. application_scores.resume_id has a
--   composite ON DELETE SET NULL (resume_id) FK onto it, so a kept score row
--   survives with resume_id nulled, never deleted — the schema allows
--   nulling there, so that's the safe choice.
--
--   job_applications — only rows still in stage 'draft' after promotion
--   (i.e. never deletes a row this call just promoted). application_stages,
--   job_contacts, application_scores, and application_job_description_versions
--   all CASCADE off application_id and are removed with their draft
--   automatically. Everything else — applied/promoted applications, their
--   stage history, scores, outcomes, outcome checks, and follow-ups — stays
--   untouched; this function never deletes a non-draft job_applications row.
--
--   application_observed_outcomes — never deleted. A draft with one is
--   promoted, not removed, so this table is never touched by this function
--   at all. The one remaining check (v_blocking_observed_outcomes) is
--   defensive, not a normal code path: by construction, every draft with an
--   observed outcome is in the promotion set, so a row here attached to a
--   draft marked for deletion should be impossible. It still refuses the
--   whole run if it somehow finds one, rather than silently destroying an
--   application's only recorded reply.
--
-- After a successful apply, no resume content, resume file reference, or
-- materialized copy of either remains anywhere in this database — until the
-- next time something legitimately creates one (a new application_resumes
-- row, or a new evidence snapshot, which starts out with nothing to copy).
--
-- Dry run vs. apply: p_apply defaults to false. In that mode the function
-- only counts — nothing is deleted or promoted, and p_expected_drafts is
-- ignored. In apply mode (p_apply = true) it requires p_expected_drafts to
-- equal the number of drafts that will be DELETED — the count AFTER
-- excluding the ones this call promotes, never the raw total — then refuses
-- the whole run (no deletes or promotions at all) if the defensive check
-- above trips, otherwise performs every promotion/delete in this one
-- function call, which is itself the atomic unit (a single top-level
-- statement is one transaction; any exception here rolls the whole call
-- back together). `set local lock_timeout` bounds how long a dry run (or an
-- apply) can wait behind a long-running concurrent transaction holding one
-- of the locks below — it surfaces as an ordinary error instead of hanging
-- the caller indefinitely.
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
    delete from public.application_evidence_snapshot_entries;
    get diagnostics v_removed_snapshot_entries = row_count;

    delete from public.application_evidence_snapshots;
    get diagnostics v_removed_snapshots = row_count;

    delete from public.application_submission_confirmations;
    get diagnostics v_removed_confirmations = row_count;

    delete from public.application_resume_recovery_imports;
    get diagnostics v_removed_recovery_imports = row_count;

    delete from public.application_outcome_check_observations
    where application_id in (select id from public.job_applications where stage = 'draft')
      and application_id <> all (v_promote_ids);
    get diagnostics v_removed_outcome_checks = row_count;

    delete from public.application_resumes;
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
