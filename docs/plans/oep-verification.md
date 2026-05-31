# OEP Verification — Philosophy and Roadmap

## The problem

A professional profile makes claims about work history. Those claims are self-reported. The gap between "I built X" and "I provably built X" is where most resume fraud lives — and where most AI hiring tools have no ground truth.

The Open Employment Protocol addresses this in layers, each buildable independently, together forming a complete chain of trust.

---

## The verification chain

```
Domain ownership          ← Phase 1 (shipped)
    │ proves: this agent is operated by whoever controls the domain
    ↓
Work evidence
    ├── Git evidence       ← Phase 2a (self-owned repos)
    ├── Peer attestation   ← Phase 2b (public posts by witnesses)
    └── Employer cosign    ← Future (requires employer-side OEP adoption)
    │ proves: the work happened at the claimed scale
    ↓
Signed envelope            ← Phase 3
    │ proves: the evidence hasn't been tampered with
    ↓
Public /verify endpoint    ← Phase 3
    proves: anyone can verify the full chain independently
```

---

## Why employment verification is deferred

The ideal proof for employed work is an **employer co-signature**: "Acme Corp attests that this person worked here as Senior Engineer from 2023-01 to 2023-08." Cryptographically strong, NDA-safe, unambiguous.

This requires the employer to run an OEP-compatible agent, expose a signing endpoint, and choose to attest records on request. None of that infrastructure exists yet. It is an **ecosystem adoption problem** — the reference implementation (this repo) is the argument for adoption. Employer co-signatures are the right long-term answer and are explicitly deferred, not abandoned.

---

## Peer attestation: what the candidate can do today

While waiting for employer-side adoption, the candidate can build a public attestation trail that any AI can discover and verify:

**Ask former colleagues to write a LinkedIn post or recommendation** saying something like:
> "Worked with [Name] at [Company] on [thing]. [One honest sentence about what they observed.]"

**Why this works:**

| Property | Value |
|---|---|
| Independent | Written by someone other than the candidate |
| Timestamped | Post date is immutable and publicly visible |
| NDA-safe | Describes the relationship, not proprietary code |
| Discoverable | Any AI or verifier can find and read it |
| Already exists | People write these posts naturally — no ceremony required |
| Unfakeable at scale | N ≥ 2 organic, independent attestations is extremely strong signal |

**The consensus principle:** One witness saying "I worked with X" could be coached. Three independent people saying the same thing, at different times, without coordinating — that is effectively irrefutable. The organic, independent corroboration is the proof, not any individual post. Retrospective posts are valid; exact timing doesn't matter.

---

## Git evidence: self-owned work

For projects where the candidate owns and controls the repo, git history is direct, factual evidence. The nightly sync fetches per-project:

- `repo_created_at` and `last_push_at` (repository host metadata — creation date and last push; not guaranteed to match actual first/last commit for imported histories)
- Total commit count
- Contributor count
- File counts by type (total, TypeScript, test files)

Stored as `git_evidence` on each project entry, surfaced in `GET /projects/:slug`. List view (`GET /projects`) omits it — detail only.

Supported providers: GitHub (Phase 2a), GitLab and Bitbucket (stubs, fillable later). Unsupported hosts skip silently.

---

## Signed evidence (Phase 3)

The Phase 1 Ed25519 key (already live) signs the canonical JSON of each project's `git_evidence` block during the nightly sync. The signature is stored alongside the evidence. Anyone can:

1. Fetch the public key from `/.well-known/oep-public-key.json`
2. Verify the key fingerprint against the DNS TXT record
3. Verify the evidence signature

`GET /verify/git-evidence?slug=<slug>` automates this. `scripts/verify-git-evidence.ts <domain> <slug>` is the CLI equivalent (same pattern as `verify-oep-domain.ts`).

---

## verification_status field

`GET /info` exposes a `verification_status` object at the profile root so any AI querying the profile understands what has been verified and what is pending:

```json
{
  "verification_status": {
    "domain": "verified",
    "git_evidence": "partial",
    "peer_attestations": "pending",
    "employer_cosignature": "pending_ecosystem",
    "note": "Domain ownership is verified via OEP Phase 1. Git evidence is available for self-owned projects. Employment verification via employer co-signature is pending ecosystem adoption; peer attestations via public LinkedIn posts are the current best available signal — the candidate welcomes LinkedIn recommendations from former colleagues."
  }
}
```

This is honest. The agent reports what it knows, what it can prove, and what requires infrastructure that doesn't exist yet.
