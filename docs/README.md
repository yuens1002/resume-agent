# docs

Documentation is split by state, not by topic:

- **`docs/*.md`** — reference docs for features that are **shipped and live**. They describe how the system actually behaves today. Update them when behavior changes.
- **[`docs/plans/*.md`](plans/)** — design docs for work that is **proposed or in progress**. A plan is merged before implementation begins and records *why* a decision was made. After a feature ships, its plan stays in `plans/` as historical record — reference docs in this root capture the live behavior.

See [ROADMAP.md](../ROADMAP.md) for what's shipped and what's in progress.

---

## Current docs

### Shipped (reference)

- [mcp-architecture.md](mcp-architecture.md) — MCP transport architecture (stateless Streamable HTTP, auth, Railway runtime)
- [resume-pipeline-v2.md](resume-pipeline-v2.md) — `/resume` endpoint's dual-gen + rubric scorer pipeline
- [workflow.md](workflow.md) — how employer AI, recruiters, and the candidate each interact with the agent

### In progress (plans)

- [plans/private-mcp-summarize-observed-queries.md](plans/private-mcp-summarize-observed-queries.md) — private MCP `summarize_observed_queries` tool for public query traffic analytics
- [plans/public-mcp-query-only.md](plans/public-mcp-query-only.md) — public `/public-mcp` endpoint with `ask_candidate` tool
- [plans/a2a-trust-layer.md](plans/a2a-trust-layer.md) — exploring: signed agent cards, invocation receipts, `/verify` endpoint
