# Roadmap

A running log of what's shipped and what's in flight. See the [README](README.md) for the project vision, architecture, and usage.

---

## Shipped

| Version | Feature | PR |
| --- | --- | --- |
| v0.2.12 | Dual-gen + rubric scorer pipeline for resume generation | [#59](https://github.com/yuens1002/resume-agent/pull/59) |
| v0.2.13 | `/.well-known/agent-card` extensionless redirect, MCP session TTL + keepalive fixes | [#61](https://github.com/yuens1002/resume-agent/pull/61) |
| v0.2.14 | Stateless MCP transport — session map removed, mid-conversation drops eliminated | [#62](https://github.com/yuens1002/resume-agent/pull/62) |
| v0.2.15 | System prompt refactor — drop length + employment-trim rules | [#63](https://github.com/yuens1002/resume-agent/pull/63) |
| v0.2.16 | Retire Supabase Edge Function artifacts, clarify Railway as runtime tier | [#65](https://github.com/yuens1002/resume-agent/pull/65) |

---

## In progress

### Public MCP endpoint with `ask_candidate` tool

**Branch:** `feat/public-mcp-query` · **Plan:** [docs/plans/public-mcp-query-only.md](docs/plans/public-mcp-query-only.md)

Adds `/public-mcp` route exposing a single MCP tool — `ask_candidate` — wrapping the existing `/query` handler. Advertised in the agent card's `supportedInterfaces` for A2A-aware client discovery. Unauthenticated, rate-limited per IP, and logs every call (plus HTTP `/query` traffic) to a new `observed_queries` table.

---

## Next

Observations from live `/public-mcp` traffic — agent card fields consumed vs ignored, tool naming that AI clients discover reliably, rate-limit thresholds that hold up, errors worth surfacing. Deliverable: `docs/plans/base-layer-observations.md`, committed incrementally as patterns emerge.

## Exploring

A trust layer for agent authenticity — signed agent cards + invocation receipts + a public verify endpoint. Early-stage design, not yet scoped for implementation. See [docs/plans/a2a-trust-layer.md](docs/plans/a2a-trust-layer.md).
