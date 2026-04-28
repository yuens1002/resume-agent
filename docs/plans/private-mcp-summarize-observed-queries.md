# Plan: Private MCP — `summarize_observed_queries` Tool

**Branch:** `claude/verify-mcp-usage-logging-0oj2B` (this plan)
**Status:** Doc-only — implementation deferred
**Scope:** Add a single read-only aggregation tool to the private (authenticated) MCP server that surfaces stats over the `observed_queries` table, so the candidate can ask the LLM things like "what did people ask this week?" or "which ATSes hit me most?" without leaving chat.

---

## Context

The public MCP (`src/routes/public-mcp.ts`) and HTTP `POST /query` both write a row per call to `observed_queries` (see `supabase/migrations/20260422000000_observed_queries.sql`). The table has RLS enabled and is `service_role` only (`supabase/migrations/20260422000001_observed_queries_rls.sql`), so today the data is reachable only via the Supabase dashboard.

The private MCP server already runs with `service_role` access and is the natural surface for the candidate's own admin/observability tools (`thought_stats`, `match_search`, `update_profile`, etc.). Adding a stats tool here closes the loop: traffic in → stored → queryable in chat.

This plan covers only `summarize_observed_queries`. A row-level reader (`list_observed_queries`) is intentionally deferred — most questions the candidate will ask are aggregate ("how many", "top N", "trend over time"), and surfacing raw question text per row carries a small privacy/cost footprint we can postpone until there's a concrete need.

---

## Goals

1. Let the candidate query `observed_queries` aggregates from chat without writing SQL or opening Supabase.
2. Cover the questions most likely to be asked: volume, source split, top callers, latency health, top user-agents, time-bucketed trend.
3. Keep the tool stateless and read-only — no schema changes to `observed_queries`, no new write paths.
4. Return a compact, LLM-friendly text summary by default; structured JSON available behind a flag for downstream tooling.
5. Reuse the existing `thought_stats` shape as a stylistic template so the private MCP stays internally consistent.

## Non-goals

- Exposing raw question/answer text or `ip_hash`/`user_agent` per-row. Aggregates only.
- Public MCP exposure. This is admin-only; lives behind the existing `/mcp` auth.
- Mirroring write logging onto private-MCP tool calls. Tracked separately — different dataset (own usage vs. external traffic), different threat model.
- Cross-table joins (e.g. correlating to `job_applications`). Out of scope; revisit if a real question needs it.
- Clustering/semantic grouping of question text. Exact-string top-N is enough for v1; embedding-based clustering is a follow-up if traffic ever justifies it.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                   resume-agent (Hono app)                             │
│                                                                       │
│   /mcp  (PRIVATE — auth required)                                     │
│     └─ buildPrivateServer()                                           │
│           ├─ … existing tools …                                       │
│           └─ summarize_observed_queries  ← NEW                        │
│                 │                                                     │
│                 └─ reads observed_queries (service_role)              │
│                                                                       │
│   /public-mcp  (PUBLIC)  ──writes──▶  observed_queries                │
│   /query       (PUBLIC)  ──writes──▶  observed_queries                │
└──────────────────────────────────────────────────────────────────────┘
```

No new tables, no migrations, no new env vars. The tool is a read-only view onto an existing table that's already populated by both public surfaces.

---

## Tool shape

**Name:** `summarize_observed_queries`
**Title:** "Summarize Public Query Traffic"
**File:** `src/routes/mcp.ts` (new `server.registerTool` block, sibling to `thought_stats`)

### Input schema

```ts
{
  since:        z.string().datetime().optional()
                  .describe('ISO timestamp lower bound. Defaults to 7 days ago.'),
  until:        z.string().datetime().optional()
                  .describe('ISO timestamp upper bound. Defaults to now.'),
  source:       z.enum(['mcp', 'http']).optional()
                  .describe('Filter to one surface. Omit for both.'),
  caller_hint:  z.string().optional()
                  .describe('Filter by caller_hint prefix (e.g. "ATS", "recruiter").'),
  bucket:       z.enum(['hour', 'day', 'week']).optional().default('day')
                  .describe('Time bucket for the trend series.'),
  top_n:        z.number().int().min(1).max(50).optional().default(10)
                  .describe('How many rows to include in top-N lists.'),
  format:       z.enum(['text', 'json']).optional().default('text')
                  .describe('"text" returns a human summary; "json" returns the raw envelope.'),
}
```

### Output envelope (when `format: 'json'`)

```ts
{
  window: { since: string, until: string, days: number },
  totals: {
    count: number,
    by_source: { mcp: number, http: number },
    distinct_user_agents: number,
    distinct_ip_hashes: number,
  },
  latency: {
    avg_ms: number,
    p50_ms: number,
    p95_ms: number,
    max_ms: number,
  },
  top_caller_hints:  Array<{ caller_hint: string | null, count: number }>,
  top_user_agents:   Array<{ user_agent: string | null, count: number }>,
  top_questions:     Array<{ question: string, count: number }>,  // exact-string match
  top_models:        Array<{ model: string | null, count: number }>,
  trend:             Array<{ bucket_start: string, count: number }>,
}
```

For `format: 'text'` (default), the tool serializes the envelope to a compact markdown block — matches the `thought_stats` precedent so the LLM can render it directly in chat.

### Default behavior

- No args → last 7 days, day buckets, top 10, text output. The shortest useful question ("how's traffic?") gets a useful answer.
- `top_questions` truncates each question to ~120 chars in the text rendering to keep responses scannable; full text is preserved in `format: 'json'`.

---

## Implementation options

Two viable paths. Recommend **Option A** for v1.

### Option A — TypeScript aggregation in the handler

- Single `select()` over `observed_queries` with the time-window + filters applied.
- Aggregate in-process: counts, percentiles, top-N via `Map`, trend via bucket-key reduction.
- Hard cap the row pull at e.g. 10k; if the window exceeds the cap, return a `truncated: true` flag in the envelope and a soft warning in the text rendering.

**Pros:** zero migration, zero RPC plumbing, easy to iterate on the shape, mirrors `thought_stats`.
**Cons:** O(rows) memory in the worker for big windows. Fine until volume grows past ~10k/week.

### Option B — Postgres view or RPC function

- New `observed_queries_summary(since, until, source, caller_hint, bucket, top_n)` SQL function returning the envelope as JSON.
- Tool becomes a thin `supabase.rpc()` wrapper.

**Pros:** scales; aggregation runs in Postgres. Reusable from future surfaces (e.g. an admin web UI).
**Cons:** new migration, harder to iterate while we're still discovering the right shape.

**Recommendation:** start with A. Promote to B only after the envelope stabilizes and either (a) row volume crosses a threshold where in-process aggregation hurts, or (b) we want to reuse the same summary in a non-MCP surface.

---

## Privacy & safety

- The tool is on the **private** MCP — already gated by the existing auth middleware. No additional access control needed.
- `ip_hash` is never returned in the envelope; only `distinct_ip_hashes` (a count) is exposed. This matches the original "no PII in observability" intent of the salt-hashing scheme in `src/lib/log-observed-query.ts:54`.
- `top_questions` does surface raw question text. That's intentional — answering "what are people asking?" is the whole point — but worth noting if we ever add lower-trust readers to the private surface.
- Read-only: no `update`/`insert`/`delete` paths added. Tool can't be repurposed for tampering.

---

## Testing

- Unit: handler with a stubbed Supabase client returning fixed rows; assert envelope math (counts, p50/p95, top-N ordering, bucket assignment across DST boundary).
- Integration: hit the private `/mcp` route with the tool call after seeding a handful of `observed_queries` rows; assert the text rendering contains the expected sections and the JSON envelope round-trips.
- Edge cases:
  - Empty window → envelope with all zeros, friendly text ("No queries in this window.").
  - `since > until` → input validation rejects with a clear MCP error.
  - Window pulling > 10k rows → `truncated: true` and the trend/top-N still computed over the capped sample with a note in the text output.

No new migrations, so no migration test pass needed.

---

## Open questions

1. **Exact-string top questions vs. normalized:** lowercase + trim before grouping? v1 says yes (cheap, matches user intuition); call out in docs that "Tell me about yourself" and "tell me about yourself!" group together.
2. **Bucket time zone:** UTC for v1 to keep aggregation deterministic; the LLM can re-interpret in the user's TZ when it renders.
3. **Should `format: 'json'` also be the default once we know the LLM can render structured output reliably?** Defer — text default keeps token cost predictable and matches sibling tools.
4. **Companion `list_observed_queries` (row reader):** explicitly out of scope here. Add when there's a concrete question aggregates can't answer.

---

## Out-of-scope follow-ups (tracked separately)

- Mirror logging onto the private MCP for own-usage stats (different dataset, different table or `source='mcp-private'` enum extension).
- Embedding-based clustering of question text for "what topics are people asking about?" once exact-string top-N stops being informative.
- Surface the same summary in an authenticated web admin view (would justify promoting to Option B).
