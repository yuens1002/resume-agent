# Roadmap

This repo is the **candidate-side reference implementation** of a broader agent-discovery pattern. The pattern — `.well-known/agent-card.json` advertising a public MCP endpoint with tools grounded in canonical published data — generalizes across verticals (employment, commerce, any marketplace where participants expose profiles). Resume-agent is the first testbed.

> **Thesis:** The agent card + public MCP pattern is a generic *base layer*. Verticals (OEP, Market-Roast) are applications of it. Each individual or organization publishes a self-sovereign agent that AI clients query for grounded responses — eliminating the hallucination-by-inference default.

---

## Layer cake

```
Layer 3: Vertical-specific agents
         ├─ OEP (Open Employment Protocol)
         │  ├─ Candidate reference (this repo)
         │  └─ Recruiter reference (oep-recruiter — not yet built)
         │
         ├─ Market-Roast (separate ecosystem — dev/market-roast)
         │  ├─ Producer agent
         │  ├─ Roaster agent
         │  ├─ Broker agent
         │  └─ Smart-roaster operator agent
         │
         └─ [any other marketplace vertical]

Layer 2: Generic base layer           ← what we're validating
         ├─ /.well-known/agent-card.json (discovery)
         ├─ Public MCP endpoint (stateless, rate-limited, no-auth)
         ├─ Tool registry conventions
         └─ A2A supportedInterfaces for cross-protocol fallback

Layer 1: Server framework (Hono)
Layer 0: Runtime (Node on Railway)
```

---

## Execution plan

### Step 1 — Public MCP on resume-agent `[IN PROGRESS]`

**Branch:** `feat/public-mcp-query` · **Plan:** [public-mcp-query-only.md](plans/public-mcp-query-only.md)

Ship `/public-mcp` route exposing a single MCP tool, `query_profile`, wrapping the existing `/query` handler. Add MCP URL to agent card `supportedInterfaces`. Recruiter connector-add section in README. Validates the base layer end-to-end on one vertical.

**Scope:** ~100-150 lines of new code, ~2-4 hrs.

### Step 2 — Observe what conventions harden `[BLOCKED ON STEP 1]`

Watch real-world usage of step 1 for ~days-to-weeks. Record: tool naming patterns that work for AI clients, rate-limit thresholds that hold up, which agent card fields get consumed vs ignored, auth behaviors observed from different clients.

Don't spec ahead of shipped code. Deliverable: a short observations doc, committed as `docs/plans/base-layer-observations.md`.

### Step 3 — Extract base-layer docs or SDK `[BLOCKED ON STEP 2]`

Promote the hardened conventions into either (a) a lightweight spec doc (`AGENT-DISCOVERY-PROTOCOL.md`) that other repos reference, or (b) a `@agent-base/server` npm package providing the generic scaffold (card, MCP route, rate limit, CORS). Could live in its own repo or inside `dev/market-roast`.

**Decision point:** Doc-first or SDK-first. Default: doc-first until a second vertical implementation demands the SDK abstraction.

### Step 4 — Build `oep-recruiter` `[BLOCKED ON STEP 1]`

New repo: Next.js + AI SDK web app. Paste a JD + candidate agent URL, app discovers the agent card, connects to its MCP, runs a screening workflow (5-8 structured queries → fit synthesis), drafts grounded outreach. Open source alongside resume-agent as the two-sided OEP reference.

**Scope:** ~3-5 focused days.

### Step 5 — Market-Roast participant templates `[BLOCKED ON STEP 3]`

Fork-to-deploy candidate-style templates for coffee-domain participants. Each mimics the resume-agent pattern with coffee-domain tools (`query_lots`, `query_capacity`, `query_roast_profiles`). Lives in `dev/market-roast` repo as per its existing vision doc.

**Scope:** Separate project. Unblocked by steps 1 + 3.

---

## What's shipped

| Version | Feature | PR |
|---|---|---|
| v0.2.12 | Dual-gen + rubric scorer pipeline for resume generation | #59 |
| v0.2.13 | `/.well-known/agent-card` redirect, MCP session TTL bump, keepalive heartbeat | #61 |
| v0.2.14 | Stateless MCP transport — session map removed, agent reconnect friction eliminated server-side | #62 |
| v0.2.15 | System prompt refactor — drop length + employment-trim rules | #63 |
| v0.2.16 | Retire Supabase Edge Function artifacts, clarify Railway as runtime tier | #65 |
| *next* | Public MCP endpoint with `query_profile` tool | *in progress* |

---

## Captured thinking in OB1

These thoughts hold the strategic context behind the roadmap. Retrievable via `/recall`:

- **Architecture thesis** (observation) — the layer cake, base layer vs vertical, "interfaceless neural link" framing
- **Execution plan** (task) — 5-step roadmap with action items
- **Public MCP scope** (task) — immediate deliverable decision lock-ins
- **Anti-hallucination / self-sovereignty** (idea) — the core property: "your agent is your truth"

---

## Cross-project links

- **Market-Roast vision** — `dev/market-roast/VISION.md` (open-source .org foundation for specialty coffee)
- **Artisan Roast (reference commerce app)** — `dev/ecomm-ai-app`
- **Omni-Roast (SMS channel layer)** — `dev/omni-roast`
