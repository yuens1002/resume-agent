# Roadmap

This repo is a reference implementation of an **agent-discovery pattern** for self-sovereign professional identity: a candidate publishes a queryable agent, AI clients discover it via `.well-known/agent-card.json`, and responses are grounded in data the candidate controls rather than inferred by the calling AI.

The pattern is deliberately generic — the same primitives (agent card + public MCP endpoint + rate-limited read-only tools) apply to any domain where participants expose profiles. Resume-agent happens to populate those primitives with a professional profile; the code is forkable for other domains.

---

## Vision — "your agent is your truth"

Without an agent to call, an AI asked "does [person] know Python?" fabricates a plausible-sounding answer from training-data patterns. That fiction then influences real hiring decisions.

With this agent published, AI clients that can discover and call it get responses grounded in canonical data the individual publishes. The candidate owns the narrative AI systems tell about them.

This project exists to make that grounded path available on real, deployable infrastructure — not as a spec proposal but as running code.

---

## Architecture layers

```
Consumer layer   Recruiter tools, hiring-manager prep assistants, AI screening agents
     ▲
     │ queries via MCP or HTTP
     │
Agent layer      This repo — agent card + public MCP + private MCP
     ▲
     │ Postgres + pgvector
     │
Data layer       Supabase (owned by candidate)
```

The **agent layer** is the contribution. The data layer is commodity (any Postgres + pgvector works). The consumer layer is whatever AI client the recruiter is using (Claude, Cursor, custom tooling).

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

**Branch:** `feat/public-mcp-query` · **Plan:** [plans/public-mcp-query-only.md](plans/public-mcp-query-only.md)

Adds `/public-mcp` route exposing a single MCP tool — `query_profile` — wrapping the existing `/query` handler. Advertised in the agent card's `supportedInterfaces` for A2A-aware client discovery. Unauthenticated, rate-limited per IP.

Once live, any AI client that supports MCP connectors (Claude.ai, Claude Desktop, Cursor) can add `https://<your-agent>/public-mcp` and ask grounded natural-language questions about the candidate.

---

## Next

### A companion consumer-side reference

The agent layer is only half the story. A **consumer-side reference implementation** — a recruiter-facing app that discovers candidate agents via their agent cards, runs structured screening workflows via MCP, and drafts grounded outreach — is planned as a separate OSS project. Details TBD; published here when the repo goes public.

### Observed-convention hardening

Once the public MCP ships, a short observations doc (`plans/base-layer-observations.md`) will capture what real-world usage teaches about agent card shape, tool naming, rate-limit thresholds, and client behavior. Those observations inform whether the agent-layer primitives get extracted as a standalone spec or SDK for other forkers.

---

## Project principles

- **Single-replica, stateless wherever possible.** Low operational overhead, horizontally scalable when needed.
- **Canonical data over inferred data.** Every response the public endpoints generate is grounded in the candidate's published profile — never fabricated by the LLM.
- **Forkable by default.** README + `.env.example` + migrations are structured so another engineer can clone, point at their own Supabase + Railway, and have a queryable agent in under 30 minutes.
- **Additive changes, never breaking.** New endpoints, new agent-card entries, new tools — old consumers keep working.

---

## Contributing

Issues and PRs welcome at [github.com/yuens1002/resume-agent](https://github.com/yuens1002/resume-agent). The `plans/` directory holds design docs for work in flight; a plan is merged before implementation begins.
