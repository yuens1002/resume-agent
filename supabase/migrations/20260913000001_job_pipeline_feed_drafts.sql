-- Drafts are recorded application rows, not confirmed submissions. The feed
-- keeps them in totals, stage breakdowns, and journal snapshots, but a
-- pre-submission row cannot create application follow-up work.
--
-- This is deliberately a forward migration: the original feed migration may
-- already have been applied, so editing it would not change deployed RPCs.
begin;

create or replace function public.get_job_pipeline_feed(
  p_generation uuid default null, p_after_sequence bigint default null,
  p_timezone text default 'UTC'
) returns jsonb language plpgsql stable security invoker set search_path = pg_catalog, public as $$
declare
  envelope jsonb;
begin
  if (p_generation is null) <> (p_after_sequence is null) or p_after_sequence < 0 then
    raise exception 'Invalid feed cursor' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'Invalid feed timezone' using errcode = '22023';
  end if;
  with bounds as (
    select generation, installed_at,
      coalesce((select max(sequence) from public.job_pipeline_changes), 0) as high_water
    from public.job_pipeline_feed_identity
  ), changed as (
    select sequence::text as sequence, application_id, operation, observed_at, application
    from public.job_pipeline_changes, bounds
    where p_after_sequence is not null and sequence > p_after_sequence and sequence <= high_water
    order by public.job_pipeline_changes.sequence limit 1001
  ), due as (
    select id as application_id, company, role, stage, applied_at, follow_up_date
    from public.job_applications
    where follow_up_date <= (statement_timestamp() at time zone p_timezone)::date
      and stage not in ('draft', 'rejected', 'withdrawn')
    order by follow_up_date, id limit 1001
  ), stage_counts as (
    select stage, count(*) as count from public.job_applications group by stage
  )
  select jsonb_build_object(
    'version', 1, 'source', 'resume-agent.job_applications',
    'as_of', statement_timestamp(), 'timezone', p_timezone,
    'baseline', p_after_sequence is null, 'history_available_since', installed_at,
    'next_cursor', jsonb_build_object('generation', generation, 'sequence', high_water::text),
    'summary', jsonb_build_object(
      'recorded_applications', (select count(*) from public.job_applications),
      'by_stage', coalesce((select jsonb_object_agg(stage, count) from stage_counts), '{}'::jsonb)),
    'changes', coalesce((select jsonb_agg(changed order by changed.sequence::bigint) from changed), '[]'::jsonb),
    'due_work', coalesce((select jsonb_agg(due order by due.follow_up_date, due.application_id) from due), '[]'::jsonb),
    'invalid_cursor', p_generation is not null and (p_generation <> generation or p_after_sequence > high_water),
    'overflow', (select count(*) > 1000 from changed) or (select count(*) > 1000 from due)
  ) into envelope from bounds;
  if envelope is null then raise exception 'Feed identity missing' using errcode = '55000'; end if;
  if (envelope->>'invalid_cursor')::boolean then
    raise exception 'Foreign or future feed cursor' using errcode = '22023';
  end if;
  if (envelope->>'overflow')::boolean then
    raise exception 'Feed exceeds 1000 changes or due items; checkpoint unchanged; operator reconciliation required'
      using errcode = '54000';
  end if;
  return envelope - 'invalid_cursor' - 'overflow';
end;
$$;

commit;
