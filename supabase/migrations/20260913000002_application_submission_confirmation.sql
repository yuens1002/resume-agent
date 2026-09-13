-- ============================================================
-- Draft application confirmation
--
-- A tailored resume is not evidence of an external submission. This
-- transition records the exact resume version that was sent while moving a
-- draft application into the applied stage, all in one database transaction.
-- ============================================================

begin;

-- The evidence migration widened job_applications for drafts, but the audit
-- table retained its original check. log_application writes both rows, so a
-- draft could be deleted by its compensating failure path before it was ever
-- visible to the caller.
alter table application_stages drop constraint if exists application_stages_stage_check;
alter table application_stages add constraint application_stages_stage_check
  check (stage in ('draft', 'applied', 'phone_screen', 'technical', 'final', 'offer', 'rejected', 'withdrawn'));

create or replace function public.confirm_application_submission(
  p_application_id uuid,
  p_resume_id uuid,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_application public.job_applications%rowtype;
  v_resume_id uuid;
begin
  -- Lock the application first. Concurrent confirmations for different
  -- resume versions serialize here, so only one can change the draft.
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

  -- The caller must identify an existing, still-unsubmitted resume that
  -- belongs to this application. No tailoring or historical row is inferred.
  select id into v_resume_id
  from public.application_resumes
  where id = p_resume_id
    and application_id = p_application_id
    and is_submitted = false
  for update;

  if not found then
    raise exception 'Unsubmitted resume evidence not found for application' using errcode = 'P0001';
  end if;

  update public.application_resumes
  set is_submitted = true
  where id = v_resume_id;

  update public.job_applications
  set stage = 'applied',
      applied_at = statement_timestamp()
  where id = p_application_id;

  insert into public.application_stages (application_id, stage, note)
  values (
    p_application_id,
    'applied',
    coalesce(nullif(btrim(p_note), ''), 'Application submission confirmed')
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

-- The direct service role remains append-only for resume evidence. Only the
-- narrowly scoped, private confirmation RPC may flip its submitted marker.
revoke all on function public.confirm_application_submission(uuid, uuid, text) from public;
revoke all on function public.confirm_application_submission(uuid, uuid, text) from anon, authenticated;
grant execute on function public.confirm_application_submission(uuid, uuid, text) to service_role;

commit;
