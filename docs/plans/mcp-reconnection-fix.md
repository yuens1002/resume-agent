# Investigate private-MCP reconnection asymmetry

## Context

Observation: claude.ai stays connected to `/public-mcp` across Railway cold starts, but `/mcp` (private) shows "reconnect required" at every cold start. Both endpoints are confirmed stateless — no in-process session map, `mcp-session-id` is stripped from responses on both routes (`src/routes/mcp.ts:797`, `src/routes/public-mcp.ts:167`), no keepalive, no GC. The only meaningful difference is auth: public is open, private requires JWT (HS256, 1h TTL) issued via PKCE OAuth.

## Root cause (per Anthropic docs)

Anthropic's connector docs (`platform.claude.com/docs/en/agents-and-tools/mcp-connector`, `support.anthropic.com` connector articles) state:

- "Claude supports token expiry and refresh — servers should support this functionality in order to provide the best experience for users."
- "Token refresh happens automatically. When the access token expires, Claude uses the refresh token to get a new one without user interaction."
- "Claude refreshes tokens reactively on a 401 response, with a proactive refresh up to five minutes before the stored expiry."

This server's OAuth metadata advertises only `authorization_code` and `client_credentials` (`src/routes/oauth.ts:55`); `/token` has no `refresh_token` branch and the token response includes no `refresh_token`. So claude.ai's documented refresh path is unavailable, and the only fallback it has when an access token expires (or when a 401 arrives) is to re-run the user-facing PKCE authorization_code flow — which surfaces as "reconnect required."

The open endpoint stays connected because there is no token to expire and no auth server to revisit. Stateless protocol-level re-init handles cold starts silently per the MCP Streamable HTTP spec.

**Cold start is not the proximate trigger** — token expiry is. Cold starts simply make the symptom feel coupled to deploys (a 1h JWT issued during the previous session expires; reconnect is needed; user blames the most recent deploy).

## Caveat that still requires verification

If 401s on `/mcp` are coming from the cold-started server rejecting *still-valid* JWTs (e.g., per-instance state being lost across boot), adding `refresh_token` doesn't fix it — Claude would refresh, get a new JWT, and that JWT would also fail. We don't expect this here because `JWT_SECRET` is env-based and HS256 verification is fully stateless, but a quick log check rules it out before committing to the fix.

## Verification (tight — confirm caveat then move to fix)

### 1. Capture one cold-start cycle

- Note current commit + Railway deploy timestamp.
- Trigger a tool call on `/mcp` and `/public-mcp` from claude.ai to confirm both connected.
- Restart Railway (or wait for one); attempt a tool call on each.
- Pull Railway logs covering ~30s before to ~2m after restart.

Look for:
- On `/mcp` at the moment claude.ai surfaces "reconnect": is the failing request a 401 from `authenticate()` on a JWT whose `exp` is in the past? (Expected — confirms expiry path.)
- Or is it a 401 on a JWT with `exp` still in the future? (Would mean stateful validation, refresh_token alone won't fix it.)
- Whether `/authorize` or `/token` is hit during reconnect, and with what `grant_type`.

If logs lack request detail, add throwaway structured logs at `src/routes/mcp.ts:786` (post-`authenticate`, log result + JWT `exp` claim if present) and `src/routes/oauth.ts:105` (entry of `/token`, log `grant_type`). Throwaway branch, do not merge.

### 2. Decode one captured JWT

From an `Authorization: Bearer …` value: read `iat` / `exp` (HS256, payload is base64url-decoded JSON, no verification needed for inspection). Confirm `exp` is the proximate cause.

## Decision

- 401 with expired JWT (expected case) → proceed to implement `refresh_token` grant.
- 401 with non-expired JWT → root cause is elsewhere; do not implement refresh_token until that's understood.
- No 401 at all but reconnect still surfaces → escalate; likely client-side claude.ai behavior, document and consider pre-warm.

## Critical files (read-only during Phase A; modified in Phase B)

- `src/routes/oauth.ts` — metadata + /authorize + /token (Phase B primary)
- `src/routes/mcp.ts` — `authenticate()` at 739–754, POST handler at 782–803
- `src/routes/public-mcp.ts` — POST handler at 138–173 (reference, no change)
- `src/lib/mcp-common.ts` — CORS + origin check (shared, no change)
- `src/index.ts` — route wiring + global rate-limit at 105–106 / 26–71
- `railway.toml` — deploy config; healthcheck `/`, single replica
- `docs/plans/mcp-stateless-refactor.md` — rationale for v0.2.14 statelessness

## Phase A exit criteria (verification)

Investigation is done when the cold-start log capture confirms expired-JWT 401 as the proximate cause. Output is a one-line confirmation. If the caveat case appears (non-expired JWT being rejected) — stop, do not proceed to Phase B, escalate.

---

## Phase B: implementation (only after Phase A confirms expiry)

### Goal

Add RFC 6749 `refresh_token` grant so claude.ai's documented automatic refresh works, eliminating the reconnect prompt at JWT expiry / cold start.

### Files to change

- **`src/routes/oauth.ts`** — primary work
  - `/.well-known/oauth-authorization-server` (line 48): add `'refresh_token'` to `grant_types_supported`.
  - `/token` (line 105): add `grant_type === 'refresh_token'` branch — validate refresh token, issue a new access token (and optionally rotate the refresh token), reject revoked/expired ones.
  - `authorization_code` branch (line 157): also issue a `refresh_token` alongside the access token, return it in the response.
  - `client_credentials` branch (line 134): conventionally does *not* return a refresh token (per RFC 6749 §4.4.3) — leave unchanged.
  - Refresh token shape: prefer signed JWT (HS256) with `typ: 'refresh'`, longer TTL (e.g., 30d), so verification stays stateless across cold starts. Avoids needing a Supabase table just for this.
  - Optional rotation: on each refresh, issue a new refresh_token and treat the old one as one-time-use. Requires a small revocation store (Supabase table `oauth_refresh_revocations` with `jti, revoked_at`). Decide whether rotation is worth the storage cost — for a single-user / low-risk connector, plain non-rotating refresh tokens are acceptable.

- **`src/routes/mcp.ts`** — likely no change
  - `authenticate()` validates access tokens only. Refresh tokens never reach `/mcp`. The `typ` claim check should be added to reject anyone passing a refresh token as a bearer.

- **`tests/`** — add coverage
  - `authorization_code` flow now returns a `refresh_token`.
  - `refresh_token` grant returns a fresh access token and (if rotating) a new refresh token.
  - Refresh fails with `invalid_grant` for: expired token, revoked token (if rotating), token presented as access bearer at `/mcp`.

- **`docs/mcp-architecture.md`** and/or **`README.md`** — note refresh support and TTLs.
- **`CHANGELOG.md`** — entry under the next version.

### Reuse from existing code

- `SignJWT` + `jwtSecretBytes` pattern at `src/routes/oauth.ts:144-148` — same signing setup, just different `typ` claim and TTL.
- `jwtVerify` pattern from `src/routes/mcp.ts:747` for validating incoming refresh tokens.
- `noCacheHeaders` constant at `src/routes/oauth.ts:132` — reuse on refresh response.
- `timingSafeEqual` at `src/routes/oauth.ts:17` — already there if a client_secret check is wanted on refresh.

### Verification (end-to-end)

1. Local: complete PKCE → receive `access_token` + `refresh_token`. Confirm both are valid HS256 JWTs with expected `typ` claims and TTLs.
2. Local: POST `/token` with `grant_type=refresh_token` and the refresh token → receive new access_token. Confirm old refresh works again (or fails, if rotation enabled).
3. Local: POST `/mcp` with the refresh_token as bearer → expect 401 (typ mismatch).
4. Local: simulate expired access_token (re-issue with `exp` in past) → confirm `/mcp` returns 401, then refresh succeeds, then new access_token works on `/mcp`.
5. Deploy to Railway. In claude.ai, disconnect + re-add the connector to pick up the new metadata (claude.ai caches `grant_types_supported`). Trigger a tool call.
6. Force-restart Railway 65+ minutes after the connector was authorized (so the original access_token has expired). Confirm claude.ai does not show "reconnect required" and the next tool call works without user interaction. Watch Railway logs for a `/token` POST with `grant_type=refresh_token`.
7. Update `tests/` and ensure `npm test` passes.

### Out of scope

- Persisting OAuth state to Supabase (separate concern, not needed for refresh_token if tokens are signed JWTs).
- Pre-warming Railway (orthogonal; refresh_token alone resolves the documented asymmetry).
- DCR (RFC 7591) — claude.ai prefers it but the existing static `OAUTH_CLIENT_ID` allowlist is working; revisit only if claude.ai rejects the connector for missing DCR after this change.

## Sources

- `platform.claude.com/docs/en/agents-and-tools/mcp-connector`
- `platform.claude.com/docs/en/agents-and-tools/remote-mcp-servers`
- `support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers` (source of the "reactive 401 / proactive 5min" refresh quote)
- `modelcontextprotocol.io/specification/2025-06-18/basic/transports` (Streamable HTTP, stateless allowed)
- `modelcontextprotocol.io/specification/draft/basic/authorization` (DCR + refresh optional in spec; claude.ai prefers them)
- RFC 6749 §6 (refresh_token grant), §4.1.4 / §4.4.3 (refresh_token issuance rules)
