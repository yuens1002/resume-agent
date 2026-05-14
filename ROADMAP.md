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
| v0.4.7 | Thoughts-grounded `/query` and `/public-mcp` — semantic search over OB1 thoughts layered above `public_profile`; `match_thoughts_public` RPC excludes `metadata.private` thoughts; behavioral/judgment questions answered from lived experience; agent card `skills.query` updated, card → 1.3.0. Plan: [`docs/plans/thoughts-grounded-query.md`](docs/plans/thoughts-grounded-query.md) | [#93](https://github.com/yuens1002/resume-agent/pull/93) |
| v0.4.13 | `/query` engagement rules + prompt-does-relevance + eval harness — named rule constants in `src/lib/query-prompt.ts` (voice / honesty / observations-relevance / off-topic / gaps / adversarial / output-json) composed by `buildSystemPrompt`; `QUERY_THOUGHTS_THRESHOLD` env-overridable; on-demand `npm run eval:query` runs ~14 fixture cases against a deterministic rubric with optional `--judge`. Plan: [`docs/plans/query-engagement-rules.md`](docs/plans/query-engagement-rules.md) | [#97](https://github.com/yuens1002/resume-agent/pull/97) |
| v0.4.15 | `/query` engagement rules **v2** — third-person factual narrator + footnote citations. Voice flip from 1st → 3rd person ("Sunny built X [1]..." not "I built X..."); new `RULE_CITATION` requires `[N]` markers + `Sources:` block on every factual claim; drops calendly contact-offer; unifies no-data + off-topic around a factual-decline posture; rubric drops `no-data-offers-contact` and adds `cites-source`; fixes the `"Kubernetes in production"` overclaim false positive. Live behavior: [`docs/query-engagement-rules.md`](docs/query-engagement-rules.md). Plan: [`docs/plans/query-engagement-rules-v2.md`](docs/plans/query-engagement-rules-v2.md) | _this PR_ |

---

## In progress

_None right now._

---

## Next

### Public MCP traffic observations

Observations from live `/public-mcp` traffic — agent card fields consumed vs ignored, tool naming that AI clients discover reliably, rate-limit thresholds that hold up, errors worth surfacing. Deliverable: `docs/plans/base-layer-observations.md`, committed incrementally as patterns emerge.

## Exploring

A broader trust layer for agent authenticity — signed agent cards + invocation receipts + a public `/verify` endpoint. Early-stage design that builds on the Phase 1 domain-verification plan above. See [docs/plans/a2a-trust-layer.md](docs/plans/a2a-trust-layer.md).
