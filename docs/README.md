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
- [query-engagement-rules.md](query-engagement-rules.md) — the behavior contract for `/query` and `/public-mcp ask_candidate`: third-person factual narrator that reads from the work-history corpus, footnote-style citations on every factual claim, factual decline for off-topic / no-data / adversarial, capability gap-naming, and prompt-does-relevance over injected OB1 observations
- [plans/public-mcp-query-only.md](plans/public-mcp-query-only.md) — public `/public-mcp` endpoint with `ask_candidate` tool (shipped — historical record of the design decision)
- [plans/oep-phase-1-domain-verification.md](plans/oep-phase-1-domain-verification.md) — OEP Phase 1: DNS-TXT domain verification, `/.well-known/oep-public-key.json`, CLI verifier (shipped — historical record)
- [plans/thoughts-grounded-query.md](plans/thoughts-grounded-query.md) — thoughts-grounded `/query` and `/public-mcp`: `match_thoughts_public` RPC, default-public-with-`private`-opt-out policy (shipped — see correction notes in the plan for what changed during implementation)
- [plans/query-engagement-rules.md](plans/query-engagement-rules.md) — `/query` engagement rules + prompt-does-relevance + eval-backed threshold (shipped — v1 historical record; superseded by v2 below for live behavior, but the threshold-as-pre-filter framing is from this plan)
- [plans/query-engagement-rules-v2.md](plans/query-engagement-rules-v2.md) — `/query` engagement rules v2: factual narrator + footnote citations (shipped — live behavior in `query-engagement-rules.md` reflects v2)
- [plans/private-mcp-summarize-observed-queries.md](plans/private-mcp-summarize-observed-queries.md) — private MCP `summarize_observed_queries` tool for public query traffic analytics

### Exploring (plans)

- [plans/a2a-trust-layer.md](plans/a2a-trust-layer.md) — signed agent cards, invocation receipts, `/verify` endpoint
