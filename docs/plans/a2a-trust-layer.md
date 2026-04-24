# Plan: A2A Trust Layer

**Status:** Early-stage — exploration, not yet scoped for implementation
**Branch:** TBD (not started)

---

## The gap

The `.well-known/agent-card.json` + public MCP pattern grounds AI responses in data the candidate publishes — but does not prove the agent is genuinely theirs. Anyone can publish an impersonator agent card at a confusing domain. The "your agent is your truth" narrative has a hole until trust signals exist.

Additionally, even when a calling AI hits the real agent, there's no way for a downstream reader to prove the AI's answer actually came from the agent's endpoint vs being fabricated ("ChatGPT answered in your voice without calling your endpoint").

---

## Proposed components (all domain-scoped, DKIM-analog)

1. **Signed agent cards** — cryptographic signature bound to domain control, analogous to DKIM-signed email. Validators verify signature against a domain-published public key.
2. **Invocation receipts** — every agent response (from HTTP or MCP) includes a signed receipt: `{ issuer, timestamp, query_hash, response_hash, signature }`. Recipients can later verify "this answer came from this agent at this time."
3. **Public `/verify?receipt=…` endpoint** — anyone can confirm a receipt. Closes the "AI answered in your voice without calling you" gap.

Scope of exploration stops at these three. A paid "verified badge" trust-as-a-service product is a separate concern, not this plan.

---

## Open questions

- Key hosting: self-hosted per agent vs a shared verification oracle
- Whether the A2A spec absorbs this natively or it ships as a spec extension
- Volatility risk — A2A spec is still evolving; building now might need rework
- Signature envelope format — JWS, COSE, or custom
- Replay protection on receipts (expiry, nonce)

---

## Blocked on

- Public MCP shipping (live traffic needed to learn what conventions matter)
- Real-world impersonation evidence OR ecosystem movement (A2A spec adds signing field, DID/VC becomes consumer-viable, registry starts offering identity-to-card attestation)

Until one of those triggers, this plan stays in exploration — not implementation.
