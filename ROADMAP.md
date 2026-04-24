# Roadmap

This repo hosts a queryable AI agent representing a professional profile. A candidate publishes the agent, AI clients discover it via `.well-known/agent-card.json`, and responses are grounded in data the candidate controls rather than inferred by the calling AI.

---

## Vision — "your agent is your truth"

Without an agent to call, an AI asked "does [person] know Python?" fabricates a plausible-sounding answer from training-data patterns. That fiction then influences real hiring decisions.

With this agent published, AI clients that can discover and call it get responses grounded in canonical data the individual publishes. The candidate owns the narrative AI systems tell about them.

This project exists to make that grounded path available on real, deployable infrastructure — not as a spec proposal but as running code.

---

## Architecture

```
AI client (recruiter / hiring manager / AI agent)
     │ queries via MCP or HTTP
     ▼
resume-agent (this repo, deployed to Railway)
     ├─ /.well-known/agent-card.json  (A2A discovery)
     ├─ /public-mcp   (public MCP — in progress)
     ├─ /mcp          (private MCP — x-brain-key or OAuth)
     ├─ /query, /match, /info, /availability, /projects, /resume  (public HTTP)
     │
     ▼ Supabase JS client
Postgres + pgvector (Supabase)
     ├─ public_profile     (read-only, public-API accessible)
     ├─ thoughts           (private, MCP-only)
     └─ job_applications   (private, MCP-only)
```

---

## What's shipped

| Version | Feature | PR |
| --- | --- | --- |
| v0.2.12 | Dual-gen + rubric scorer pipeline for resume generation | [#59](https://github.com/yuens1002/resume-agent/pull/59) |
| v0.2.13 | `/.well-known/agent-card` extensionless redirect, MCP session TTL + keepalive fixes | [#61](https://github.com/yuens1002/resume-agent/pull/61) |
| v0.2.14 | Stateless MCP transport — session map removed, mid-conversation drops eliminated | [#62](https://github.com/yuens1002/resume-agent/pull/62) |
| v0.2.15 | System prompt refactor — drop length + employment-trim rules | [#63](https://github.com/yuens1002/resume-agent/pull/63) |
| v0.2.16 | Retire Supabase Edge Function artifacts, clarify Railway as runtime tier | [#65](https://github.com/yuens1002/resume-agent/pull/65) |

---

## In progress

### Public MCP endpoint with `query_profile` tool

**Branch:** `feat/public-mcp-query` · **Plan:** [docs/plans/public-mcp-query-only.md](docs/plans/public-mcp-query-only.md)

Adds `/public-mcp` route exposing a single MCP tool — `query_profile` — wrapping the existing `/query` handler. Advertised in the agent card's `supportedInterfaces` for A2A-aware client discovery. Unauthenticated, rate-limited per IP.

Once live, any AI client that supports MCP connectors (Claude.ai, Claude Desktop, Cursor) can add `https://<your-agent>/public-mcp` and ask grounded natural-language questions about the candidate.

---

## Next

### Observations from live public-MCP usage

Once `/public-mcp` ships, capture what real-world traffic teaches — agent card fields consumed vs ignored, tool naming that AI clients discover reliably, rate-limit thresholds that hold up, errors worth surfacing. Deliverable: `docs/plans/base-layer-observations.md`, committed incrementally as patterns emerge.

---

## Project principles

- **Single-replica, stateless wherever possible.** Low operational overhead, horizontally scalable when needed.
- **Canonical data over inferred data.** Every response the public endpoints generate is grounded in the candidate's published profile — never fabricated by the LLM.
- **Forkable by default.** README + `.env.example` + migrations are structured so another engineer can clone, point at their own Supabase + Railway, and have a queryable agent in under 30 minutes.
- **Additive changes, never breaking.** New endpoints, new agent-card entries, new tools — old consumers keep working.

---

## Contributing

Issues and PRs welcome at [github.com/yuens1002/resume-agent](https://github.com/yuens1002/resume-agent). The [`docs/plans/`](docs/plans/) directory holds design docs for work in flight; a plan is merged before implementation begins.
