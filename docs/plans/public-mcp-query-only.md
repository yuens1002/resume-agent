# Plan: Public MCP — `ask_candidate` Tool

**Branch:** `feat/public-mcp-query`
**Status:** Planning complete — ready to implement
**Scope:** Public MCP endpoint exposing a single tool, `ask_candidate`, for AI clients to ask natural-language questions about the candidate's profile. Includes streaming support and persistent call logging.

---

## Context

Today, AI clients querying about the candidate's profile have two paths: (1) plain HTTP `POST /query` with a question in the body, or (2) the A2A agent card at `/.well-known/agent-card.json` for discovery. Neither is an MCP-native interface that AI clients supporting custom connectors (Claude.ai, Claude Desktop, Cursor) can consume directly as a callable tool.

This plan adds the MCP-native path by exposing a single tool, `ask_candidate`, at a new `/public-mcp` route. The tool wraps the same handler logic as the existing HTTP `/query` endpoint so prompt changes and response shape stay in sync.

---

## Goals

1. Wrap the existing `/query` endpoint logic as an MCP tool callable by any MCP-aware AI client (Claude.ai, Claude Desktop, Cursor, etc.)
2. Advertise the MCP endpoint in the existing agent card so A2A-aware clients can auto-discover it when clients support that path
3. Provide a 30-second connector-add path in the README
4. Preserve JSON parity with the HTTP `/query` response shape so downstream consumers can rely on a single contract
5. Capture every public-MCP call to a persistent store (new `observed_queries` table) for observability — same pattern as `job_applications`, enables future analytics without retroactive instrumentation
6. Support streaming responses for AI clients that prefer progressive rendering

## Non-goals

- Exposing `/match`, `/info`, `/availability`, `/projects`, or `/resume` as MCP tools. These stay HTTP-only.
- Authentication on the public MCP. No OAuth, no API key. Same trust model as the public `/query` HTTP endpoint.
- Multi-tool public server. Single-tool scope is deliberate — `ask_candidate` already exposes the full profile surface via natural language.
- Cryptographic trust signals (signed agent cards, invocation receipts, `/verify` endpoint). Tracked separately; out of scope for this deliverable.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      resume-agent (Hono app)                          │
│                                                                       │
│   /mcp  (PRIVATE — auth required)                                    │
│     └─ buildPrivateServer()  ·  15 tools (OB1 + job pipeline)        │
│                                                                       │
│   /public-mcp  (PUBLIC — no auth, rate-limited)  ← NEW               │
│     └─ buildPublicServer()   ·  1 tool: ask_candidate                │
│           │                                                           │
│           ├─ calls queryProfile() core                               │
│           └─ logs call to observed_queries table                     │
│                                                                       │
│   /query  (PUBLIC HTTP — unchanged response contract)                │
│     └─ handleQuery(c, …)                                             │
│           │                                                           │
│           ├─ calls queryProfile() core                               │
│           └─ logs call to observed_queries table                     │
│                                                                       │
│   /.well-known/agent-card.json                                       │
│     └─ supportedInterfaces: [MCP, HTTP+JSON]  ← MCP listed first     │
└──────────────────────────────────────────────────────────────────────┘

                              │
                              ▼
                  Supabase (data tier)
                  ├─ public_profile       (existing, read by queryProfile)
                  └─ observed_queries     (new, written by both paths)
```

Both the public MCP tool and the HTTP `/query` route call the same `queryProfile` core — prompt changes, profile loading, and response shape stay in one place. Both also log each call to `observed_queries`, enabling observability across both surfaces with one query.

---

## Implementation shape

### 1. Extract shared query core

**File:** `src/routes/query.ts`

Split the existing `handleQuery` into two pieces:

- `queryProfile({ question, context, stream? })` — pure function. Loads profile, calls LLM, returns `QueryResponse` (or a `ReadableStream` for `stream: true`). No Hono Context dependency. Used by both the HTTP route and the MCP tool.
- `handleQuery(c, question, context, stream)` — thin Hono wrapper that calls `queryProfile` and serializes to `c.json` or text stream response. Retains existing behavior.

### 2. New `observed_queries` table + helper

**File:** `supabase/migrations/<timestamp>_observed_queries.sql` (new)

Schema:

```sql
create table observed_queries (
  id            uuid primary key default gen_random_uuid(),
  source        text not null check (source in ('http', 'mcp')),
  question      text not null,
  caller_hint   text,
  answer        text,
  confidence    text,
  sources       jsonb,
  model         text,
  latency_ms    integer,
  ip_hash       text,
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index observed_queries_created_at_idx on observed_queries (created_at desc);
create index observed_queries_source_idx on observed_queries (source);
```

`ip_hash` is SHA-256 of IP + a server-side salt (rotated periodically) — enables per-session-ish abuse detection without storing raw IPs.

**File:** `src/lib/log-observed-query.ts` (new)

Helper function `logObservedQuery({ source, question, caller_hint, response, latency_ms, ip_hash?, user_agent? })`. Called by both the HTTP handler and the MCP tool handler. Fire-and-forget with error swallowing — logging must never break the response path.

### 3. New public-MCP route

**File:** `src/routes/public-mcp.ts` (new, ~100-150 lines)

Mirrors the structure of `src/routes/mcp.ts` but:

- `buildPublicServer()` registers ONLY `ask_candidate`
- No `authenticate()` call in the POST handler
- Same stateless Streamable HTTP transport as private `/mcp`
- Reuses `corsHeaders`, `checkOrigin` helpers from `src/routes/mcp.ts` (extracted to `src/lib/mcp-common.ts` in this PR to enable reuse)
- Strips `mcp-session-id` from responses (same pattern as private route)

Tool shape:

```ts
server.registerTool(
  'ask_candidate',
  {
    title: 'Ask the Candidate',
    description:
      'Ask a natural-language question about this candidate\'s skills, experience, or background. ' +
      'Responses are grounded in the candidate\'s canonical published profile — not inferred by the calling AI. ' +
      'Use this when a recruiter, hiring manager, or screening tool needs answers about the candidate.',
    inputSchema: {
      question: z.string().describe('Natural-language question about the candidate'),
      context: z.string().optional().describe('Optional caller context: "ATS", "recruiter", "ai-agent", etc. Adjusts tone.'),
      stream: z.boolean().optional().describe('If true, the response streams progressively via MCP progress notifications.'),
    },
  },
  async ({ question, context, stream }, { sendNotification }) => {
    const start = Date.now()

    if (stream && sendNotification) {
      // Stream via progress notifications; yields partial text chunks as the LLM generates
      const reader = await queryProfile({ question, context, stream: true })
      let collected = ''
      const decoder = new TextDecoder()
      for await (const chunk of reader) {
        const text = decoder.decode(chunk)
        collected += text
        await sendNotification({
          method: 'notifications/progress',
          params: { progressToken: 'ask_candidate', message: text },
        })
      }
      await logObservedQuery({ source: 'mcp', question, caller_hint: context, response: { answer: collected }, latency_ms: Date.now() - start })
      return { content: [{ type: 'text', text: collected }] }
    }

    const result = await queryProfile({ question, context })
    await logObservedQuery({ source: 'mcp', question, caller_hint: context, response: result, latency_ms: Date.now() - start })
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)
```

The tool response includes the full `{ answer, confidence, sources, follow_up_suggestions, contact, meta }` envelope as a stringified JSON blob. `contact.email` and `contact.calendly` are included — keeps the recruiter's AI able to suggest grounded next-step outreach.

### 4. Register the route

**File:** `src/index.ts`

```ts
import publicMcpRoute from './routes/public-mcp.js'
// ...
app.route('/public-mcp', publicMcpRoute)
```

### 5. Update agent card

**File:** `src/routes/agent-card.ts`

Prepend the MCP entry to `supportedInterfaces` so A2A-aware clients prefer it by default:

```ts
supportedInterfaces: [
  {
    url: `${baseUrl}/public-mcp`,
    protocolBinding: 'MCP',
    protocolVersion: '2025-03-26',
  },
  {
    url: baseUrl,
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0',
  },
],
```

Bump agent card `version` to `1.1.0`.

### 6. README — "Add as a custom connector" section

**File:** `README.md`

New section explains:

- Connector URL pattern: `https://<your-agent-domain>/public-mcp`
- No auth needed
- Rate-limited to 30 req/min per IP (shared bucket with `/query` HTTP)
- Three example prompts recruiters can use once connected

### 7. Update shipped reference doc

**File:** `docs/mcp-architecture.md`

Add a section documenting `/public-mcp` alongside `/mcp`, explaining the public vs private tool split.

---

## Decisions locked from planning session

1. **Tool name:** `ask_candidate`
2. **Response shape:** Full JSON envelope stringified as a single text block (preserves parity with HTTP `/query` response)
3. **Rate limit:** Shared bucket — public MCP traffic counts against the same 30-req/min per-IP limit as existing HTTP routes
4. **Streaming:** Included in v1 via MCP progress notifications (opt-in via `stream: true` parameter)
5. **Agent card interface order:** MCP first, HTTP second
6. **Test file organization:** Two files — `tests/public-mcp-transport.test.ts` and `tests/public-mcp-tool.test.ts` — with shared setup in `tests/helpers/public-mcp.ts`
7. **Logging / observability:** Persistent table `observed_queries`, written from both HTTP and MCP handlers. IP stored as salted hash for abuse detection without PII retention
8. **Contact in responses:** Full `contact.email` + `contact.calendly` block included, same as HTTP `/query`

---

## Acceptance criteria

### Transport layer — `tests/public-mcp-transport.test.ts`

- AC-1: POST `/public-mcp` without credentials — returns 2xx (no auth required)
- AC-2: POST `/public-mcp` response — no `mcp-session-id` header
- AC-3: GET `/public-mcp` — returns 404
- AC-4: DELETE `/public-mcp` — returns 404
- AC-5: CORS headers present on responses
- AC-6: Disallowed origin → 403 (same origin allowlist as private route)
- AC-7: OPTIONS preflight — 200/204 with CORS headers
- AC-8: Rate limit applies — 31st request from same IP in 60s returns 429 (shared bucket)

### Tool behavior — `tests/public-mcp-tool.test.ts`

- AC-9: `tools/list` returns exactly one tool — `ask_candidate`
- AC-10: `ask_candidate` call with a known question about the candidate returns a non-empty `answer`, valid `confidence`, and at least one `source`
- AC-11: `ask_candidate` non-streaming response text is valid JSON matching the `/query` HTTP response shape
- AC-12: `context` parameter influences tone (caller context propagates)
- AC-13: `ask_candidate` response includes `contact.email` and `contact.calendly` when present on the profile
- AC-14: `ask_candidate` with `stream: true` emits at least one `notifications/progress` message before the final response
- AC-15: `observed_queries` row is written with `source='mcp'` after every `ask_candidate` call, with all payload-derived columns populated: `question`, `answer`, `confidence`, `sources` (jsonb), `model`, `latency_ms` (verify by Supabase query)
- AC-16: HTTP `/query` path also writes a `observed_queries` row with `source='http'` and full field parity (same populated columns as AC-15)

### Agent card

- AC-17: `/.well-known/agent-card.json` lists the MCP interface with `protocolBinding: "MCP"` and correct URL
- AC-18: MCP interface appears first in `supportedInterfaces` array
- AC-19: Agent card `version` bumped to `1.1.0`

### Database

- AC-20: Migration `observed_queries.sql` applied cleanly via `npm run db:push`
- AC-21: `observed_queries` schema matches the plan (columns, indexes, check constraint on `source`)

### Documentation

- AC-22: README section "Add as a custom connector" exists with connector-add instructions and example prompts (automated grep for section header + URL pattern)
- AC-23: `docs/mcp-architecture.md` updated to document the public MCP route alongside the private one (automated grep for `/public-mcp` reference)

### Regression safety

- AC-24: Existing private `/mcp` transport tests (`tests/mcp-transport.test.ts` — the current 15-AC suite) still pass after helpers are extracted to `src/lib/mcp-common.ts`. Runs as part of `npm run test:transport`.
- AC-25: `logObservedQuery` helper must swallow errors — if the `observed_queries` insert fails (unreachable DB, constraint violation, etc.) the tool/HTTP response still returns successfully. Implementer provides a unit test for the helper using a stubbed client that throws; caller must not re-throw.

---

## Test infrastructure

- **New file:** `tests/helpers/public-mcp.ts` — shared fixtures (test question prompts, expected response shape helpers, Supabase query helpers for verifying logged rows)
- **New file:** `tests/public-mcp-transport.test.ts` — transport-layer ACs (AC-1 through AC-8), importing shared setup
- **New file:** `tests/public-mcp-tool.test.ts` — tool behavior + logging + contact ACs (AC-9 through AC-16), importing shared setup
- **New `npm run test:public-mcp`** — runs both public-MCP test files. Existing `test:transport` unchanged.

---

## Rollback

```bash
git revert <merge-commit>
```

The migration adds a new table only — no destructive schema changes. Railway redeploys automatically. If rollback happens post-migration, the `observed_queries` table can stay (harmless) or be dropped manually if desired.

---

## What this unlocks

Once live:

- Any recruiter or AI-native tool that supports MCP custom connectors can add `https://<your-agent-domain>/public-mcp` and ask grounded questions about the candidate
- Streaming support makes progressive rendering possible for clients that prefer it
- `observed_queries` gives us a single observability surface — every public query lands in one table regardless of transport
- Establishes the `/public-mcp` pattern for any future public tools (still single-tool at v1; additive expansion possible later)
