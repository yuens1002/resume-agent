-- Closes #277: rotate_refresh_token's ownership check was conditional on
-- p_client_id being non-null ("if p_client_id is not null and ..."), so a
-- caller who simply omitted client_id skipped the check entirely — the
-- refresh_token grant's own request now requires client_id (and, at the
-- application layer, client_secret) unconditionally, but this closes the
-- same gap at the RPC layer too, as defense in depth against any future
-- caller that doesn't go through the /token handler.

create or replace function rotate_refresh_token(
  p_token_hash  text,
  p_client_id   text,
  p_new_hash    text,
  p_new_expires timestamptz
)
returns json
language plpgsql
security definer
as $$
declare
  v_row oauth_refresh_tokens%rowtype;
begin
  select * into v_row
    from oauth_refresh_tokens
   where token_hash = p_token_hash;

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
