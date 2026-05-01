-- Add consumed flag to distinguish replayed tokens from unknown ones,
-- apply correct RLS grants matching the repo's security model,
-- and provide an atomic rotate_refresh_token RPC that wraps consume+issue in one transaction.

-- ── Schema change ────────────────────────────────────────────────────────────

alter table oauth_refresh_tokens
  add column if not exists consumed boolean not null default false;

comment on column oauth_refresh_tokens.consumed is
  'True once the token has been exchanged during rotation. Kept for replay detection.';

-- ── RLS grants (mirrors observed_queries_rls pattern) ────────────────────────

revoke all on table oauth_refresh_tokens from public;
revoke all on table oauth_refresh_tokens from anon;
revoke all on table oauth_refresh_tokens from authenticated;
grant all on table oauth_refresh_tokens to service_role;

create policy "Service role full access"
  on oauth_refresh_tokens
  for all
  to service_role
  using (true)
  with check (true);

-- ── Atomic rotate function ───────────────────────────────────────────────────
-- Wraps the consume-old + issue-new steps in a single transaction.
-- Returns a JSON object with a `status` field and, on success, `client_id`.
--
-- Status values:
--   not_found      — token never existed or already cleaned up; no action taken
--   expired        — token exists but has passed its expiry; no action taken
--   client_mismatch — caller supplied a client_id that doesn't match the stored one; token NOT consumed
--   replayed       — token was already consumed (definite replay); all active tokens for client revoked
--   rotated        — success; old token marked consumed, new token inserted

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

  -- Validate ownership before consuming; wrong client_id leaves the token intact
  if p_client_id is not null and p_client_id <> v_row.client_id then
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
