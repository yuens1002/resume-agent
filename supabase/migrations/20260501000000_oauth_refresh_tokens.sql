-- oauth_refresh_tokens: durable store for OAuth refresh tokens issued to the Claude connector.
-- Replaces the in-memory Map so tokens survive Railway restarts and redeploys.
-- Stores a SHA-256 hash of each token (never the raw value) for defence-in-depth.
-- Rotation is enforced at the application layer: old row is atomically deleted on redemption
-- and a new row is inserted, enabling server-side reuse detection.

create table if not exists oauth_refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  client_id   text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists oauth_refresh_tokens_client_id_idx
  on oauth_refresh_tokens (client_id);

create index if not exists oauth_refresh_tokens_expires_at_idx
  on oauth_refresh_tokens (expires_at);

-- Service-role key bypasses RLS; no end-user access is needed or allowed.
alter table oauth_refresh_tokens enable row level security;
