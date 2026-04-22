# Plan: MCP Stateless Transport Refactor

**Branch:** `feat/mcp-stateless`
**Status:** Ready to implement
**Motivation:** Real-world usage confirmed that stateful SSE sessions create unavoidable reconnect friction across all Claude surfaces (mobile, web, new conversations). All 15+ MCP tools are stateless round-trips — none require server-side session state or persistent SSE streams.

---

## Goal

Remove the in-memory session map from `/mcp` and switch to per-request McpServer instantiation. Every POST becomes self-contained: create server, handle request, discard. No session ID issued, no GC, no TTL, no single-replica constraint.

---

## What changes

### `src/routes/mcp.ts`

**Remove entirely:**
- `McpSession` interface
- `sessions: Map<string, McpSession>`
- `SESSION_TTL_MS` constant
- GC `setInterval` (runs every 5 min evicting stale sessions)
- `session.lastUsed` tracking
- Keepalive `setInterval` + `TransformStream` pipe (30s ping)

**Rewrite POST handler:**
```ts
mcpRoute.post('*', async (c) => {
  const originErr = checkOrigin(c)
  if (originErr) return originErr
  if (!await authenticate(c)) return unauthorized(c)

  const server = buildServer()
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)

  const response = await transport.handleRequest(c)
  if (!response) return c.json({ error: 'No response from MCP transport' }, 500, corsHeaders)

  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value)
  }
  return response
})
```

**Remove GET handler** (SSE stream endpoint — not needed without sessions).
Strip or replace with 405 if clients probe it.

**Remove DELETE handler** (session teardown — not needed without sessions).
Strip or replace with 204 no-op if clients call it.

**Verify:** `StreamableHTTPTransport` does not issue a `mcp-session-id` header in stateless mode. If it does, strip it from the response before returning to prevent clients from re-using it.

### `railway.toml`

Remove or update the `numReplicas = 1` constraint comment. Without in-process session state, replicas ≥ 1 are all valid. Leave the value at 1 for now (no reason to scale yet) but remove the "session affinity required" justification from comments.

---

## Doc alignment (update alongside implementation)

| File | What to update |
|---|---|
| `docs/mcp-architecture.md` | Full rewrite — see updated version committed alongside this plan |
| `docs/workflow.md` | Session management section: remove reconnect/TTL language; update status table row for claude.ai mobile |
| `src/routes/mcp.ts` | Inline comment block above POST handler |

---

## Verification

- [ ] `POST /mcp` with `initialize` returns tool list — no session ID in response headers
- [ ] `capture_thought` writes to Supabase correctly
- [ ] `search_thoughts` returns results
- [ ] `list_thoughts` returns results
- [ ] Auth still enforced — unauthenticated POST returns 401
- [ ] CORS headers present on all responses
- [ ] Origin check still blocks disallowed browser origins
- [ ] No `mcp-session-id` header leaking in responses (would confuse clients)

---

## What this does NOT fix

**New conversation reconnect on claude.ai mobile** — each new Claude conversation starts without an MCP session. In stateless mode this is transparent (no session to establish), but claude.ai mobile may still require a manual "connect" action at conversation start depending on connector behavior. This is a platform constraint, not a server-side issue.

---

## Rollback

```bash
git revert <merge-commit>
```

Railway redeploys automatically. The previous stateful implementation is preserved in git history.
