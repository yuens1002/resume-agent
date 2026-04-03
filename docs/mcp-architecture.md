# MCP Server Architecture

The MCP endpoint at `/mcp` runs on Railway as part of the main Hono server (`src/routes/mcp.ts`).

---

## Transport: SSE (target) / JSON response mode (current)

The server is being migrated from `StreamableHTTPTransport` with `enableJsonResponse: true` (stateless per-request) to full SSE streaming transport. Reasons:

**Session drops** — the current mode creates a new `McpServer` and transport on every POST. When Claude's connector sends a `mcp-session-id` from a previous call, the server doesn't recognise it and the client surfaces a disconnect.

**Railway idle timeout** — Railway's reverse proxy closes idle TCP connections after ~5 minutes. With no persistent stream or heartbeat, any gap between tool calls longer than that hits a closed connection.

**Automation engine dependency** — the job-hunt-agent pipeline makes sustained MCP calls (`log_application`, `list_applications`, `upsert_project`) during automated job discovery and status checks. JSON response mode drops sessions under that load.

SSE fixes all three: persistent connection, server-side heartbeat every 25s, and session state preserved in a server-side Map with 10-minute TTL eviction.

---

## Session management

Once SSE lands, sessions are cached by `mcp-session-id`:

- **POST** — creates a new session on first request; reuses cached session on subsequent ones
- **GET** — returns the SSE stream for an existing session
- **DELETE** — tears down the session and closes the stream
- Sessions evict after 10 minutes of inactivity

---

## Authentication

Two paths, checked in order:

1. **Static key** — `x-brain-key` header matches `MCP_ACCESS_KEY` env var (Claude Desktop direct access)
2. **JWT** — `Authorization: Bearer <token>` verified with `jose` against `JWT_SECRET` (claude.ai OAuth connector)

---

## Supabase Edge Functions (backup / emergency recovery)

Two Edge Functions are kept in `supabase/functions/` as standby fallbacks — they are **not** the primary servers:

| Function | Primary | Fallback role |
|---|---|---|
| `open-brain-mcp` | Railway `/mcp` (SSE) | Read-compatible JSON-mode MCP if Railway goes down |
| `oauth-token` | Railway `/token` | OAuth token issuance if Railway goes down |

Edge Functions cannot hold long-lived SSE connections (cold-start limits, no heartbeat support), so the MCP fallback operates in degraded mode — stateless, no session persistence. Suitable for read-only tool calls (`search_thoughts`, `list_applications`) but not for sustained automation pipelines.

To reinstate either: re-deploy to Supabase and update the relevant URLs in the claude.ai connector settings or `/.well-known/oauth-authorization-server`.

A dedicated read-only Supabase Edge Function (purpose-built for the degraded fallback role, not a copy of the Railway server) is worth considering once the SSE primary is stable.

---

## Railway configuration

Single replica required for session affinity (sessions live in process memory):

```toml
[deploy]
startCommand = "npm start"
healthcheckPath = "/"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
numReplicas = 1
```
