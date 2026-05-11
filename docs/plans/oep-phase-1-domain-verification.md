# Plan: OEP Phase 1 — Domain Verification (DNS TXT)

**Branch:** `feat/oep-domain-verification` (not started)
**Status:** Planning — ready for review
**Scope:** Prove that the operator of `agent.<domain>` controls `<domain>` via a DNS TXT record + a key fingerprint exposed by the agent. This is the "self-signed cert moment" for the Open Employment Protocol (OEP). One-shot, no signatures, no `/verify` handshake — those are subsequent phases.

---

## Context

The public MCP endpoint and A2A agent card ground AI responses in published data — but neither proves the agent is operated by the person it claims to represent. Anyone can stand up `agent.someone-else.me` and serve an imposter card. Without a domain-binding signal, the "your agent is your truth" narrative has a hole.

OEP's design uses SSL/Let's Encrypt as its mental model: the root of trust is **domain ownership**, proven by publishing a known token at a DNS-controlled path. This plan ships the smallest possible version of that proof — a DNS TXT record containing the fingerprint of a public key the agent publishes over HTTPS. A verifier checks the two values match.

This is intentionally narrower than `docs/plans/a2a-trust-layer.md`, which sketches signed agent cards, invocation receipts, and a `/verify` endpoint. Those depend on domain verification existing first; this plan delivers that prerequisite.

---

## Goals

1. Generate an Ed25519 keypair for the agent operator, stored as env vars on Railway (private key) and exposed via HTTP (public key).
2. Publish the public-key fingerprint as a DNS TXT record at `_oep.<root-domain>`.
3. Expose the raw public key at `GET /.well-known/oep-public-key.json` so any verifier can fetch it.
4. Provide a CLI verification script (`scripts/verify-oep-domain.ts <domain>`) that performs the DNS lookup, fetches the published key, computes its fingerprint, and reports match/mismatch with exit code 0/1.
5. Document the setup steps in the README under a new "OEP domain verification" section.

## Non-goals

- Signing the agent card or any individual response.
- The `/verify?receipt=…` endpoint for invocation receipts.
- Key rotation tooling — Phase 1 ships with a single static key; rotation is a follow-up.
- A registry, attestation oracle, or any third-party trust anchor. OEP Phase 1 is self-signed by design.
- Multi-domain or subdomain delegation (e.g. proving control of `agent.yuens.me` from `yuens.me`). Single-root only for now.
- Employer-side `/role` endpoint, employment co-signatures, or mutual handshake. Those are separate plans.

---

## Architecture

```
DNS                                 HTTPS
─────────────────────              ──────────────────────────────────
_oep.yuens.me  TXT                 agent.yuens.me
  "v=oep1;                         /.well-known/oep-public-key.json
   alg=ed25519;                      { "alg": "ed25519",
   fp=<base64url-sha256-of-key>"      "key": "<base64url-public-key>",
                                      "fingerprint": "<base64url-sha256-of-key>" }
        │                                       │
        │   (1) verifier reads TXT              │   (2) verifier fetches JSON
        ▼                                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Verifier: scripts/verify-oep-domain.ts <domain>                 │
│                                                                   │
│  1. DNS TXT lookup at _oep.<domain> → fingerprint_dns            │
│  2. Resolve agent host: agent card url || agent.<domain>         │
│  3. GET https://<agent-host>/.well-known/oep-public-key.json     │
│  4. sha256(decoded(json.key)) → fingerprint_computed             │
│  5. assert fingerprint_dns == json.fingerprint == fingerprint_   │
│     computed                                                      │
│  6. Exit 0 (verified) or 1 (mismatch) with a one-line summary    │
└──────────────────────────────────────────────────────────────────┘
```

### TXT record format

```
_oep.yuens.me.  300  IN  TXT  "v=oep1; alg=ed25519; fp=Y2hh...base64url"
```

Single record. Semicolon-separated key=value pairs. `v=oep1` is a version marker so we can iterate. Fingerprint is base64url-encoded SHA-256 of the raw 32-byte Ed25519 public key (no padding).

### Public-key endpoint

`GET https://agent.yuens.me/.well-known/oep-public-key.json` returns:

```json
{
  "alg": "ed25519",
  "key": "<base64url 32-byte raw public key>",
  "fingerprint": "<base64url SHA-256 of raw key, no padding>",
  "issued_at": "2026-05-11T00:00:00Z",
  "version": "oep1"
}
```

Served from the Hono app with `Cache-Control: public, max-age=300`. No auth.

---

## Implementation shape

1. **`scripts/generate-oep-keypair.ts`** — one-shot generator. Uses `crypto.generateKeyPairSync('ed25519')`, prints the base64url private key (to copy into Railway as `OEP_PRIVATE_KEY`), the base64url public key (as `OEP_PUBLIC_KEY`), and the TXT-record value to paste into the DNS provider. Never writes to disk — operator copy/paste is the safety boundary.

2. **`src/lib/oep-key.ts`** — pure helpers: `loadPublicKeyFromEnv()` returns `null` when `OEP_PUBLIC_KEY` is unset (no throw); `fingerprint(rawKey: Uint8Array): string`; `decodePublicKey()` validates 32-byte length and throws on malformed input. The route layer (not this lib) decides what to do with `null`.

3. **`src/routes/oep.ts`** — `GET /.well-known/oep-public-key.json` handler. Reads `OEP_PUBLIC_KEY` via `loadPublicKeyFromEnv()`. Returns `503` with a JSON error when the env is unset or malformed — the app continues running. Bad config never crashes the agent; it just makes this one endpoint unavailable until configured. Mounted in `src/index.ts`.

4. **`scripts/verify-oep-domain.ts`** — CLI verifier, invoked via `npx tsx scripts/verify-oep-domain.ts <domain>` (consistent with the other repo scripts). Uses Node's `dns/promises` for TXT lookup, native `fetch` for the well-known endpoint. Argument is a bare domain (`yuens.me`); the script discovers the agent host via the agent card's `url` field or falls back to `agent.<domain>`. Prints one line: `OEP verification: PASS / FAIL — <reason>`. Exit codes 0/1.

5. **`tests/oep-domain.test.ts`** — covers: fingerprint stability (same key → same fingerprint), endpoint contract (returns the expected JSON shape from a stubbed env), verifier success path (against a local Hono instance with a mocked DNS resolver), verifier failure paths (TXT missing, fingerprint mismatch, well-known 404, malformed JSON).

6. **README** — new "OEP domain verification" section: what it proves, how to generate a key, what to paste in DNS, how anyone can verify.

7. **Agent card** — add an optional `provider.identity.fingerprint` field referencing the same base64url SHA-256. Bump card version. Verifiers that read the agent card first don't need a separate DNS lookup to know which fingerprint to expect.

---

## Decisions locked from planning session

1. **Ed25519 over RSA.** 32-byte keys, fast verification, dominant choice in modern signature stacks (SSH, age, Tor, libsodium). RSA's larger keys gain nothing here.
2. **Raw key bytes, not PEM, in `OEP_PUBLIC_KEY`.** Base64url encoding of the 32 raw bytes keeps the env var short and avoids PEM-header parsing edge cases.
3. **DNS record at `_oep.<root>`, not at the agent host.** Underscored subdomain convention matches `_acme-challenge`, `_dmarc`, etc. Verifiers query the root domain even when the agent lives at `agent.<root>` — proving control of the root, not just the agent host.
4. **No signing in this PR.** Domain verification is the foundation; signed cards and invocation receipts are separate, larger work. Keeping this small ships the proof-of-concept fast and lets us watch how it's used before committing to a signature envelope (JWS vs COSE vs custom).
5. **CLI verifier ships in this repo.** The verifier is small (~40 lines) and serves as both reference implementation and end-to-end test fixture. A standalone npm package can come later.
6. **Static key, no rotation tooling.** Rotation needs a "previous-key still valid for N days" window and DNS-aware sequencing. Out of scope for Phase 1.

---

## Acceptance criteria

**Endpoint contract**
- AC-1: `GET /.well-known/oep-public-key.json` returns `200` with `Content-Type: application/json` and a body matching the documented shape.
- AC-2: `fingerprint` field equals `base64url(sha256(base64url-decode(key)))`.
- AC-3: Response carries `Cache-Control: public, max-age=300`.

**Key handling**
- AC-4: When `OEP_PUBLIC_KEY` is unset or malformed, the route returns `503` with a JSON `{ error: "..." }` body. Same behavior in dev and production — the agent keeps running, only the OEP endpoint is unavailable until configured.
- AC-5: `fingerprint()` is deterministic — same input bytes produce identical output across runs.

**Verifier**
- AC-6: `scripts/verify-oep-domain.ts <domain>` exits `0` and prints `PASS` when the DNS fingerprint, the endpoint's `fingerprint` field, and the recomputed `sha256(key)` all agree.
- AC-7: Exits `1` and prints `FAIL — <reason>` for: missing TXT record, malformed TXT value, well-known 404, malformed JSON, fingerprint mismatch.
- AC-8: Verifier discovers the agent host from the agent card's `url` when reachable; falls back to `agent.<domain>` otherwise.

**Docs / regression**
- AC-9: README "OEP domain verification" section exists and walks through key generation → DNS publish → verification in under 10 steps.
- AC-10: Agent card includes `provider.identity.fingerprint` matching the env-derived value; card version bumped; existing agent-card tests still pass.

---

## Rollback

Single revert: `git revert <merge-sha>` removes the route, scripts, and docs. The DNS TXT record stays in place harmlessly — it has no effect once the endpoint is gone, and can be deleted from the DNS provider at leisure. No data migrations, no env-var orphans (the unused `OEP_PUBLIC_KEY` simply stops being read).

---

## What this unlocks

- **Signed agent cards** — once domain verification is a fixture, the next plan adds a detached signature over the agent card body, verifiable using the same public key already published here.
- **Invocation receipts + `/verify` endpoint** — each agent response carries a signed receipt referencing the same key; recipients can call `/verify` to confirm the response came from the agent's endpoint.
- **Employment co-signatures** — two domain-verified entities (e.g. an employer's verified domain + the candidate's) co-sign a data block. The signature scheme is identical to invocation receipts; only the workflow differs.
- **Mutual `/verify` handshake** — the protocol's bidirectional trust step. Each side proves domain control to the other before either commits time. All of this rests on the DNS root proven here.
