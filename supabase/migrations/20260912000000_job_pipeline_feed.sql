-- Minimal source journal; no historical events are fabricated on installation.
-- db:push uses psql per file, without an outer transaction. Own this boundary
-- so a failed/replayed migration cannot expose a missing capture trigger.
begin;
set local lock_timeout = '5s';
lock table public.job_applications in share row exclusive mode;

create table if not exists public.job_pipeline_feed_identity (
  singleton boolean primary key default true check (singleton),
  generation uuid not null default gen_random_uuid(),
  installed_at timestamptz not null default now()
);
insert into public.job_pipeline_feed_identity(singleton) values (true) on conflict do nothing;

create table if not exists public.job_pipeline_changes (
  sequence bigint generated always as identity primary key,
  application_id uuid not null,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  observed_at timestamptz not null default clock_timestamp(),
  application jsonb not null
);
alter table public.job_pipeline_changes enable row level security;
alter table public.job_pipeline_feed_identity enable row level security;
revoke all on public.job_pipeline_changes, public.job_pipeline_feed_identity from public, anon, authenticated;
grant select on public.job_pipeline_changes, public.job_pipeline_feed_identity to service_role;

create or replace function public.capture_job_pipeline_change()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  source_application public.job_applications%rowtype;
  current_application jsonb;
  previous_application jsonb;
begin
  if TG_OP = 'DELETE' then source_application := OLD;
  else source_application := NEW; end if;
  select jsonb_build_object(
    'application_id', source_application.id, 'company', source_application.company,
    'role', source_application.role, 'stage', source_application.stage,
    'applied_at', source_application.applied_at, 'follow_up_date', source_application.follow_up_date
  ) into current_application;
  if TG_OP = 'UPDATE' then
    previous_application := jsonb_build_object(
      'application_id', OLD.id, 'company', OLD.company, 'role', OLD.role,
      'stage', OLD.stage, 'applied_at', OLD.applied_at, 'follow_up_date', OLD.follow_up_date);
    if current_application = previous_application then return NEW; end if;
  end if;
  -- Hold until commit/rollback; allocate the sequence only after the lock.
  -- Otherwise a reader could checkpoint past a lower, uncommitted sequence.
  perform pg_advisory_xact_lock(741029, 1);
  insert into public.job_pipeline_changes(application_id, operation, application)
    values ((current_application->>'application_id')::uuid, TG_OP, current_application);
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;
revoke all on function public.capture_job_pipeline_change() from public;
drop trigger if exists job_pipeline_change on public.job_applications;
create trigger job_pipeline_change after insert or update or delete on public.job_applications
  for each row execute function public.capture_job_pipeline_change();

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
  -- STABLE uses the calling statement's snapshot for identity, totals, changes,
  -- and due work. No application list cap participates in aggregation.
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
      and stage not in ('rejected', 'withdrawn')
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
revoke all on function public.get_job_pipeline_feed(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.get_job_pipeline_feed(uuid, bigint, text) to service_role;
commit;
