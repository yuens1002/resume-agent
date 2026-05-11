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

---

## In progress

_None right now — public MCP shipped; awaiting live traffic before the next step._

---

## Next

### OEP Phase 1 — domain verification (DNS TXT)

**Plan:** [docs/plans/oep-phase-1-domain-verification.md](docs/plans/oep-phase-1-domain-verification.md)

The "self-signed cert moment" for the Open Employment Protocol. Publish an Ed25519 public key at `/.well-known/oep-public-key.json` and its fingerprint as a DNS TXT record at `_oep.<root>`; ship a CLI verifier that proves the two match. Smallest possible step that establishes domain ownership as the OEP root of trust — foundation for signed cards, invocation receipts, and employment co-signatures down the line.

### Public MCP traffic observations

Observations from live `/public-mcp` traffic — agent card fields consumed vs ignored, tool naming that AI clients discover reliably, rate-limit thresholds that hold up, errors worth surfacing. Deliverable: `docs/plans/base-layer-observations.md`, committed incrementally as patterns emerge.

## Exploring

A broader trust layer for agent authenticity — signed agent cards + invocation receipts + a public `/verify` endpoint. Early-stage design that builds on the Phase 1 domain-verification plan above. See [docs/plans/a2a-trust-layer.md](docs/plans/a2a-trust-layer.md).
