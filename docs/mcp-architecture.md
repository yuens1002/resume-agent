# MCP Server Architecture

The MCP endpoint at `/mcp` runs on Railway as part of the main Hono server (`src/routes/mcp.ts`).

---

## Transport: Stateless Streamable HTTP

Each POST to `/mcp` is a self-contained request-response cycle. The server creates a fresh `McpServer` and `StreamableHTTPTransport` per request, handles it, and discards both. No session state is kept in process memory.

**Why stateless:**

- All 15+ tools are synchronous Supabase round-trips — no tool requires server-side continuity between calls
- Stateful SSE sessions caused mid-conversation drops on Claude mobile when the OS killed background TCP connections; the 10-minute TTL (later extended to 30 min) was a workaround for a problem the architecture itself created
- Stateless mode eliminates reconnect friction across all surfaces: claude.ai web, mobile, Claude Desktop, Claude Code, and the job-hunt-agent automation pipeline
- Removes the single-replica Railway constraint (session affinity no longer required)

**Current status:** Stateless Streamable HTTP transport is live as of v0.2.14. The previous stateful SSE implementation (v0.2.13, TTL 30 min, keepalive heartbeat) has been replaced; the refactor plan in [`docs/plans/mcp-stateless-refactor.md`](plans/mcp-stateless-refactor.md) is now implemented.

---

## Session management

None. Each POST is independent. No `mcp-session-id` is issued. Clients do not need to establish or maintain sessions.

---

## Authentication

Two paths, checked in order:

1. **Static key** — `x-brain-key` header matches `OPEN_BRAIN_KEY` env var (Claude Desktop / direct API access)
2. **JWT** — `Authorization: Bearer <token>` verified with `jose` against `JWT_SECRET` (claude.ai OAuth connector)

Unauthenticated requests receive `401` with a `WWW-Authenticate` header pointing to `/.well-known/oauth-protected-resource`.

---

## Supabase role — data tier only

Supabase hosts the Postgres database (with pgvector) — that is its **only** role in this project. Migrations live in `supabase/migrations/` and are applied via `npm run db:push`. All application code runs on Railway.

The `open-brain-mcp` and `oauth-token` Supabase Edge Functions were **retired** as of v0.2.14 when the MCP transport moved fully to Railway. Their source has been removed from the repo; refer to git history if you need to reference the legacy implementation.

---

## Railway configuration

```toml
[deploy]
startCommand = "npm start"
healthcheckPath = "/"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
numReplicas = 1
```

Single replica is fine for current load. With stateless transport, horizontal scaling (numReplicas > 1) is safe — no session affinity required.

---

## A2A autodiscovery

Agent card served at `/.well-known/agent-card.json`. Two redirect aliases:

- `/.well-known/agent.json` → `/.well-known/agent-card.json` (301)
- `/.well-known/agent-card` → `/.well-known/agent-card.json` (301, added v0.2.13)
