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
| v0.3.0 | Public MCP endpoint with `ask_candidate` tool — single unauthenticated MCP tool wrapping `/query`, advertised first in agent card `supportedInterfaces`, every call logged to `observed_queries` | [#66](https://github.com/yuens1002/resume-agent/pull/66) |
| v0.4.4 | OEP Phase 1 — domain verification (DNS TXT). Ed25519 public key at `/.well-known/oep-public-key.json`, fingerprint mirrored in `_oep.<root>` TXT record, CLI verifier, fingerprint surfaced on agent card. Plan: [`docs/plans/oep-phase-1-domain-verification.md`](docs/plans/oep-phase-1-domain-verification.md) | [#90](https://github.com/yuens1002/resume-agent/pull/90) |

---

## In progress

_None right now._

---

## Next

### Thoughts-grounded `/query` and `/public-mcp`

**Plan:** [docs/plans/thoughts-grounded-query.md](docs/plans/thoughts-grounded-query.md)

The "soul of the agent" move. Today the public surface answers only from `public_profile` (skills, employment bullets, projects) — judgment, tradeoffs, and "aha" moments live in OB1 thoughts but are invisible to public callers. This plan ports the existing `/resume` thoughts-injection pattern (semantic search via `match_thoughts`) to `/query` and `/public-mcp`, with a sibling `match_thoughts_public` RPC that respects a default-public-with-`private`-opt-out policy. Audit on 2026-05-11 confirmed 100% of 1,913 captured thoughts are public-eligible; the asymmetry matches reality.

### Public MCP traffic observations

Observations from live `/public-mcp` traffic — agent card fields consumed vs ignored, tool naming that AI clients discover reliably, rate-limit thresholds that hold up, errors worth surfacing. Deliverable: `docs/plans/base-layer-observations.md`, committed incrementally as patterns emerge.

## Exploring

A broader trust layer for agent authenticity — signed agent cards + invocation receipts + a public `/verify` endpoint. Early-stage design that builds on the Phase 1 domain-verification plan above. See [docs/plans/a2a-trust-layer.md](docs/plans/a2a-trust-layer.md).
