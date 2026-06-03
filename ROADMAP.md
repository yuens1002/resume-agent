# Roadmap

A running log of what's shipped and what's in flight. See the [README](README.md) for the project vision, architecture, and usage.

---

## Shipped

| Version | Feature | PR |
| --- | --- | --- |
| v0.2.12 | Dual-gen + rubric scorer pipeline for resume generation | [#59](https://github.com/yuens1002/resume-agent/pull/59) |
| v0.3.0 | Public MCP endpoint — `ask_candidate` tool, logged to `observed_queries`, advertised in agent card | [#66](https://github.com/yuens1002/resume-agent/pull/66) |
| v0.4.4 | OEP Phase 1 — Ed25519 domain verification (DNS TXT fingerprint, `/.well-known/oep-public-key.json`, CLI verifier) | [#90](https://github.com/yuens1002/resume-agent/pull/90) |
| v0.4.7 | Thoughts-grounded `/query` — semantic search over OB1 thoughts layers lived experience above structured profile; behavioral questions answered from observations | [#93](https://github.com/yuens1002/resume-agent/pull/93) |
| v0.4.13 | `/query` engagement rules + eval harness — named `RULE_*` constants, on-demand `npm run eval:query` with deterministic rubric | [#97](https://github.com/yuens1002/resume-agent/pull/97) |
| v0.4.15 | `/query` v2 — third-person narrator, footnote citations (`[N]` markers + `Sources:` block required on every factual claim) | [#100](https://github.com/yuens1002/resume-agent/pull/100) |
| v0.4.20 | `GET /` serves agent card; `GET /health` endpoint | [#106](https://github.com/yuens1002/resume-agent/pull/106) |
| v0.4.23 | `GET /openapi.json` (Custom GPT Actions schema); `GET /qr` (QR code PNG, `QR_TARGET_URL`-controlled) | [#108](https://github.com/yuens1002/resume-agent/pull/108) |
| v0.4.25 | `cover` image URL field on Project schema; populated from Supabase Storage | [#111](https://github.com/yuens1002/resume-agent/pull/111) |
| v0.4.29 | Conversational mode (`style: "conversational"` / `x-agent-type: human`) — 2–4 sentence prose, no inline citations; `jd_term_count` in rubric response | [#115](https://github.com/yuens1002/resume-agent/pull/115) |
| v0.4.30 | Sync auto-infers `status`, `url`, `tech` from GitHub repo metadata; `parseCommitCount`, `buildRepoStats`, `detectGitProvider` helpers | [#117](https://github.com/yuens1002/resume-agent/pull/117) |
| v0.4.32 | **OEP Phase 2a** — git evidence per project (commit count, file stats, contributors); `GitProvider` abstraction; `verification_status` on `GET /info` | [#122](https://github.com/yuens1002/resume-agent/pull/122) |
| v0.4.33 | MIT `LICENSE` file | [#123](https://github.com/yuens1002/resume-agent/pull/123) |
| v0.4.34 | **OEP Phase 3** — Ed25519-signed git evidence; `GET /verify/git-evidence`; `scripts/verify-git-evidence.ts` CLI; README identity arc | [#124](https://github.com/yuens1002/resume-agent/pull/124) |
| v0.4.35 | Query performance — skip thought embedding for binary questions (18× overhead reduction), 5-min profile cache, `maxTokens: 512` for conversational | [#127](https://github.com/yuens1002/resume-agent/pull/127) |
| v0.4.36 | `/query` eval 16/16, 25/25 — premise-absent behavioral few-shot closes the chronic `behavioral-when-you-stopped` citation gap | [#128](https://github.com/yuens1002/resume-agent/pull/128) |
| v0.4.37 | Employment consolidation — auto-apply OB1 delta proposals on configurable schedule with rubric gate; OB1 notification on apply | [#130](https://github.com/yuens1002/resume-agent/pull/130) |
| v0.4.41 | CI: Node.js 24 runner; OEP + employment sync env vars wired into GitHub Actions | [#133](https://github.com/yuens1002/resume-agent/pull/133), [#134](https://github.com/yuens1002/resume-agent/pull/134) |
| v0.4.42 | Docs: `resume-agent-web` companion linked; architecture diagram updated; roadmap refreshed | [#136](https://github.com/yuens1002/resume-agent/pull/136) |

---

## In progress

_None right now._

---

## Next

### OEP Phase 2b — peer attestation discovery
LinkedIn public post search for third-party attestations ("I worked with X at Y at Z"). Organic consensus (N ≥ 2 independent witnesses) is the proof model — no timestamp required, retrospective posts are valid. Requires LinkedIn OAuth. See issue [#119](https://github.com/yuens1002/resume-agent/issues/119).

### GitLab + Bitbucket git evidence providers
`GitLabProvider` and `BitbucketProvider` in `scripts/sync.ts` are stubs. Fill them in so non-GitHub repos get signed git evidence too.

### A2A registry submission
Submit `/.well-known/agent-card.json` to [a2aregistry.org](https://a2aregistry.org), [a2agent.net](https://a2agent.net/agent-registry), and open a PR on `prassanna-ravishankar/a2a-registry`.

---

## Exploring

### OEP employer co-signatures
The ideal proof for employed work: the employer's own agent co-signs the employment claim. Requires employer-side OEP adoption — an ecosystem problem, not a code problem. The reference implementation (this repo) is the argument for adoption. See [`docs/plans/oep-verification.md`](docs/plans/oep-verification.md).

### A2A trust layer
Signed agent cards and invocation receipts — prove that a specific AI response came from this agent, not a fabricated answer in your voice. Depends on Phase 3 signing infrastructure. See [`docs/plans/a2a-trust-layer.md`](docs/plans/a2a-trust-layer.md).
