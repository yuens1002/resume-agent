# Plan: Public MCP — `query_profile` Tool

**Branch:** `feat/public-mcp-query`
**Status:** Planning — draft for review before implementation
**Scope:** Minimum viable public MCP endpoint exposing a single tool, `query_profile`, for AI clients to ask natural-language questions about the candidate's profile.

---

## Context

Today, AI clients querying about the candidate's profile have two paths: (1) plain HTTP `POST /query` with a question in the body, or (2) the A2A agent card at `/.well-known/agent-card.json` for discovery. Neither is an MCP-native interface that AI clients supporting custom connectors (Claude.ai, Claude Desktop, Cursor) can consume directly as a callable tool.

This plan adds the MCP-native path by exposing a single tool, `query_profile`, at a new `/public-mcp` route. The tool wraps the same handler logic as the existing HTTP `/query` endpoint so prompt changes and response shape stay in sync.

---

## Goals

1. Wrap the existing `/query` endpoint logic as an MCP tool callable by any MCP-aware AI client (Claude.ai, Claude Desktop, Cursor, etc.)
2. Advertise the MCP endpoint in the existing agent card so A2A-aware clients can auto-discover it when clients support that path
3. Give recruiters a 30-second connector-add path (README section + QR flow)
4. Preserve JSON parity with the HTTP `/query` response shape so downstream consumers can rely on a single contract

## Non-goals

- Exposing `/match`, `/info`, `/availability`, `/projects`, or `/resume` as MCP tools. These stay HTTP-only.
- Authentication on the public MCP. No OAuth, no API key. Same trust model as the public `/query` HTTP endpoint.
- Multi-tool public server. Single-tool scope is deliberate — `query_profile` already exposes the full profile surface via natural language.
- Streaming responses. The private `/mcp` supports SSE via Streamable HTTP transport; public MCP can do the same, but `query_profile` returns a complete response — no mid-call streaming needed.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Railway (resume-agent Hono)                      │
│                                                                       │
│   /mcp  (PRIVATE — auth required)                                    │
│     └─ buildPrivateServer()  ·  15 tools (OB1 + job pipeline)        │
│                                                                       │
│   /public-mcp  (PUBLIC — no auth, rate-limited)  ← NEW               │
│     └─ buildPublicServer()   ·  1 tool: query_profile                │
│                                                                       │
│   /query  (PUBLIC HTTP — unchanged)                                  │
│     └─ handleQuery(c, question, context, stream)  ← shared core      │
│                                                                       │
│   /.well-known/agent-card.json                                       │
│     └─ supportedInterfaces: [HTTP+JSON, MCP]  ← add MCP entry        │
└──────────────────────────────────────────────────────────────────────┘
```

Both the public MCP tool and the HTTP `/query` route call the same `handleQuery` core — prompt changes, profile loading, and response shaping stay in one place.

---

## Implementation shape

### 1. Extract shared query core

**File:** `src/routes/query.ts`

Split the existing `handleQuery` into two pieces:

- `queryProfile({ question, context, stream? })` — pure function returning `QueryResponse` (or streaming). No Hono Context dependency. Used by both the HTTP route and the MCP tool.
- `handleQuery(c, question, context, stream)` — thin Hono wrapper that calls `queryProfile` and serializes to `c.json` / stream response.

### 2. New public-MCP route

**File:** `src/routes/public-mcp.ts` (new, ~80 lines)

Mirrors the structure of `src/routes/mcp.ts` but:

- `buildPublicServer()` registers ONLY `query_profile`
- No `authenticate()` call in the POST handler
- Same stateless Streamable HTTP transport as private `/mcp`
- Reuses `corsHeaders`, `checkOrigin` helpers (extract to shared module if needed)
- Strips `mcp-session-id` from responses (same pattern as private route)

Tool shape:

```ts
server.registerTool(
  'query_profile',
  {
    title: 'Query Candidate Profile',
    description:
      'Ask a natural-language question about this candidate\'s skills, experience, or background. ' +
      'Responses are grounded in the candidate\'s canonical published profile — not inferred by the calling AI. ' +
      'Use this to answer questions a recruiter, hiring manager, or screening tool would ask.',
    inputSchema: {
      question: z.string().describe('Natural-language question about the candidate'),
      context: z.string().optional().describe('Optional caller context: "ATS", "recruiter", "ai-agent", etc. Adjusts tone.'),
    },
  },
  async ({ question, context }) => {
    const result = await queryProfile({ question, context })
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)
```

### 3. Register the route

**File:** `src/index.ts`

```ts
import publicMcpRoute from './routes/public-mcp.js'
// ...
app.route('/public-mcp', publicMcpRoute)
```

### 4. Update agent card

**File:** `src/routes/agent-card.ts`

Add a second entry to `supportedInterfaces`:

```ts
supportedInterfaces: [
  {
    url: baseUrl,
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0',
  },
  {
    url: `${baseUrl}/public-mcp`,
    protocolBinding: 'MCP',
    protocolVersion: '2025-03-26',
  },
],
```

Bump agent card `version` to `1.1.0` since we're adding a new interface.

### 5. README — recruiter connector-add section

**File:** `README.md`

New section: "Add as a custom connector in Claude". Includes:

- Direct URL for claude.ai custom connector settings: `https://agent.yuens.me/public-mcp`
- No auth needed
- What to ask once connected (example prompts)

### 6. Positioning changes (already in working tree)

- `agent-card.ts` description — already updated to self-sovereignty framing
- `README.md` "Your agent is your truth" paragraph — already added
- `docs/workflow.md` "What the agent solves: identity grounding" section — already added

---

## Acceptance criteria

### Transport layer (extend `tests/mcp-transport.test.ts` or new `tests/public-mcp-transport.test.ts`)

- AC-1: POST `/public-mcp` without credentials — returns 2xx (no auth required)
- AC-2: POST `/public-mcp` response — no `mcp-session-id` header
- AC-3: GET `/public-mcp` — returns 404
- AC-4: DELETE `/public-mcp` — returns 404
- AC-5: CORS headers present on authenticated responses
- AC-6: Disallowed origin → 403 (same origin allowlist as private route)
- AC-7: OPTIONS preflight — 200/204 with CORS headers
- AC-8: Rate limit still applies — 31st request from same IP in 60s returns 429

### Tool behavior (new `tests/public-mcp-tool.test.ts`)

- AC-9: `tools/list` returns exactly one tool — `query_profile`
- AC-10: `query_profile` call with a known question about the candidate returns a non-empty `answer`, valid `confidence`, and at least one `source`
- AC-11: `query_profile` response matches the shape of `/query` HTTP response (JSON parity — same core logic, same shape)
- AC-12: `context` parameter influences tone (caller context propagates)

### Agent card

- AC-13: `/.well-known/agent-card.json` lists the MCP interface with `protocolBinding: "MCP"` and correct URL
- AC-14: Agent card `version` bumped to `1.1.0`

### Documentation

- AC-15: README section "Add as a custom connector" exists with copy-paste URL
- AC-16: `docs/mcp-architecture.md` updated to document the public MCP route alongside the private one

---

## Open questions for planning session

These need alignment before implementation starts:

1. **Tool name — `query_profile` vs `ask` vs `ask_candidate` vs `query_agent`?**
   Tradeoffs: `query_profile` is explicit and maps to the endpoint; `ask_candidate` is more conversational and reads well in AI prompts; `ask` is terse and relies on server name for context. My recommendation: **`query_profile`** — explicit wins for machine legibility.

2. **Response shape — raw JSON string or structured MCP content?**
   The `/query` HTTP endpoint returns `{ answer, confidence, sources, follow_up_suggestions, contact, meta }`. MCP tools return `content: [{ type: 'text', text: ... }]`. Options: (a) stringify the full JSON into a single text block (consistent with HTTP response), (b) return just the `answer` string and drop the envelope, (c) structured content with multiple blocks (answer, then sources as separate block). My recommendation: **(a)** — preserves the contract, clients can parse the JSON.

3. **Rate limit strategy — separate bucket or share with `/query`?**
   Existing IP rate limit applies to all routes globally. Do we want public MCP traffic to share the 30-req/min bucket with HTTP `/query`, or separate? My recommendation: **share** — a single recruiter's AI might hit both the agent card and the tool in the same workflow; one bucket is simpler.

4. **Streaming — skip entirely for v1?**
   `/query?stream=true` HTTP variant streams text. MCP tools can return streamed content in SSE mode. My recommendation: **skip for v1** — adds complexity, no immediate consumer for it, can add later if a client needs it.

5. **Agent card interface order — HTTP first or MCP first?**
   Determines which interface an A2A-aware client prefers by default. My recommendation: **MCP first** — signals that this agent is meant to be consumed agentically.

6. **Test infrastructure — extend `test:transport` script or add new one?**
   Existing script runs `tests/mcp-transport.test.ts`. Options: (a) add public MCP tests to the same file, (b) new `test:public-transport` script. My recommendation: **(a)** — one file, clearly labeled sections.

7. **Logging / observability — log every public MCP call?**
   Helpful for seeing who's querying and what they ask. Privacy-sensitive: logs would contain questions about the candidate. My recommendation: **log to stdout only** (Railway captures), no persistent analytics store yet.

8. **Return `contact.email` in tool responses?**
   The HTTP `/query` response includes contact email/calendly. Should the MCP tool? My recommendation: **yes** — keeps the recruiter's AI able to suggest next-step outreach grounded in the candidate's published contact path.

---

## Rollback

```bash
git revert <merge-commit>
```

Railway redeploys automatically. No data migrations, no schema changes, strictly additive.

---

## What this unlocks

Once live:

- Any recruiter or AI-native tool that supports MCP custom connectors can add `https://<deployment>/public-mcp` and ask grounded questions about the candidate
- Gives the "your agent is your truth" narrative a live, demonstrable surface
- Establishes the `/public-mcp` pattern for any future public tools we may choose to add (still single-tool at v1; additive expansion possible later)
