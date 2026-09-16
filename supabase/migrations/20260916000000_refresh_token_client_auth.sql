-- Closes #277: rotate_refresh_token's ownership check was conditional on
-- p_client_id being non-null ("if p_client_id is not null and ..."), so a
-- caller who simply omitted client_id skipped the check entirely — the
-- refresh_token grant's own request now requires client_id (and, at the
-- application layer, client_secret) unconditionally, but this closes the
-- same gap at the RPC layer too, as defense in depth against any future
-- caller that doesn't go through the /token handler.
--
-- Internal review on this migration surfaced a second, unrelated gap in the
-- same function, pre-dating #277 entirely: unlike every other security
-- definer RPC in this repo (see confirm_application_submission,
-- get_job_pipeline_feed, create_application_evidence_snapshot, etc., each of
-- which explicitly revokes execute from public/anon/authenticated), this
-- function never had that lockdown applied since its own creation. Postgres
-- grants EXECUTE on a new function to PUBLIC by default, and `create or
-- replace function` preserves whatever ACL a function already has — so it
-- stayed callable via PostgREST's anon-key RPC endpoint the entire time,
-- letting anyone holding a stolen raw refresh_token rotate it with no
-- client_secret at all, bypassing this same PR's application-layer fix
-- entirely for that attack path. Confirmed live: an anon-key POST to
-- rotate_refresh_token with a non-existent token hash returned 200
-- {"status":"not_found"} rather than a permission error, proving the
-- function was reachable pre-fix. Closed below by matching this repo's own
-- established convention. Also added the same `for update` row lock every
-- other rotate/consume-style RPC in this repo already takes (see
-- confirm_application_submission, record_application_outcome_check) — its
-- absence here meant two concurrent redemptions of the same not-yet-consumed
-- token could both pass every check and both write a new row, since a bare
-- `select` takes no lock under READ COMMITTED.

create or replace function rotate_refresh_token(
  p_token_hash  text,
  p_client_id   text,
  p_new_hash    text,
  p_new_expires timestamptz
)
returns json
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row oauth_refresh_tokens%rowtype;
begin
  select * into v_row
    from oauth_refresh_tokens
   where token_hash = p_token_hash
     for update;

  if not found then
    return json_build_object('status', 'not_found');
  end if;

  -- Definite replay: token was already consumed during a previous rotation
  if v_row.consumed then
    delete from oauth_refresh_tokens
     where client_id = v_row.client_id
       and not consumed;
    return json_build_object('status', 'replayed', 'client_id', v_row.client_id);
  end if;

  if v_row.expires_at <= now() then
    return json_build_object('status', 'expired');
  end if;

  -- Validate ownership before consuming; wrong OR missing client_id leaves
  -- the token intact. `is null` is checked explicitly because `null <> x`
  -- evaluates to NULL (not true) in SQL's three-valued logic, which would
  -- otherwise let a null p_client_id silently fall through this check the
  -- same way the old "p_client_id is not null and ..." guard did.
  if p_client_id is null or p_client_id <> v_row.client_id then
    return json_build_object('status', 'client_mismatch');
  end if;

  -- Atomic consume + issue
  update oauth_refresh_tokens
     set consumed = true
   where token_hash = p_token_hash;

  insert into oauth_refresh_tokens (token_hash, client_id, expires_at)
  values (p_new_hash, v_row.client_id, p_new_expires);

  return json_build_object('status', 'rotated', 'client_id', v_row.client_id);
end;
$$;

revoke all on function public.rotate_refresh_token(text, text, text, timestamptz) from public;
revoke all on function public.rotate_refresh_token(text, text, text, timestamptz) from anon, authenticated;
grant execute on function public.rotate_refresh_token(text, text, text, timestamptz) to service_role;
