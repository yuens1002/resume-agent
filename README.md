# resume-agent

A fork-ready, machine-queryable AI agent you deploy to represent your professional profile. **This repo is the backend layer — API, MCP servers, OEP verification, and job-hunt pipeline.** The human-facing web UI lives in the companion repo [resume-agent-web](https://github.com/yuens1002/resume-agent-web).

Three access tiers: a public HTTP API for employer AI systems, a public MCP server (`ask_candidate` tool) that any MCP-aware AI client can add as a custom connector, and a private MCP server for personal interaction.

Built on top of [OB1 (Open Brain)](https://github.com/NateBJones-Projects/OB1) by Nate B. Jones — OB1 handles the knowledge capture and storage layer; this project handles the public-facing agentic interface and job match methodology.

> **Reference instance:** [agent.yuens.me](https://agent.yuens.me) — scan the [QR](https://agent.yuens.me/qr) or paste the URL into any AI to see it in action before you fork.

---

## What you get when you fork

Three problems this project solves out of the box — the work is done; you inherit it.

**Identity** — Your deployed instance is tied to your domain via DNS fingerprint + Ed25519 key (OEP Phase 1). A fork at a different domain can't reproduce your proof. Verifiable by anyone: `npx tsx scripts/verify-oep-domain.ts your-domain.com`. Full chain: [Fork the code. Your identity is yours.](#fork-the-code-your-identity-is-yours)

**Trust** — The agent card, public key, and verification scripts are independently auditable. No third party required — verifiers run the scripts themselves against your domain and either get a cryptographic PASS or they don't. Full chain: [Fork the code. Your identity is yours.](#fork-the-code-your-identity-is-yours)

**Truth** — Every factual claim is cited inline and grounded in data you publish. The agent declines rather than fabricates, and a deterministic eval harness enforces this — run `npm run eval:query` and watch it pass or fail case-by-case. Full spec: [Truth contract — we walk the talk](#truth-contract--we-walk-the-talk)

---

## Why this exists

AI systems are increasingly the first pass in hiring. ATS tools, qualification agents, and personal AI assistants are being used to screen candidates before a human ever looks at a resume. This project meets that reality head-on: expose a structured, queryable endpoint that any AI system can interrogate, and give the candidate (you) a private agentic interface to interact with the same knowledge base — generating tailored resumes, scoring job fit, and managing the job hunt pipeline.

The public endpoint is not a portfolio site. It is not a chatbot. It is an agent that answers questions about professional history with structured, machine-readable JSON that downstream systems can act on.

**Your agent is your truth.** When a recruiter's AI asks "does this person know Python?" without your agent, it *infers* an answer from training-data patterns — fabricating a plausible-sounding profile from nothing. With your agent, the AI calls your canonical endpoint and responses are grounded in the data *you* publish and control. The individual owns the narrative AI systems tell about them — the interface-less neural link that keeps AI honest about you.

---

## Fork the code. Your identity is yours.

This repo is MIT-licensed — fork it, deploy your own instance, build a product on top of it. That is the explicit intent. The README guides you through it, the OpenAPI schema is published so any platform can integrate, and the `robots.txt` welcomes AI crawlers. This is a reference implementation meant to be replicated.

But forking the code does not clone the identity. If someone deployed this repo with your name, your employment history, and your contact details — that is impersonation, not a license question. MIT licenses software; it does not license you.

**This is where the Open Employment Protocol comes in.** OEP Phase 1 ties your agent to a domain you control via a DNS fingerprint. A fork deployed at a different domain cannot reproduce your `_oep.yourdomain.com` DNS record. Any AI or verifier running `verify-oep-domain yourdomain.com` gets a cryptographic PASS for your agent — and gets nothing for theirs. Your domain is your root of trust.

The full chain — each layer independently verifiable:

| Layer | What it proves | Who can verify |
|---|---|---|
| **MIT code** | Anyone can run this software | N/A — it's a license |
| **OEP Phase 1** — domain fingerprint | Only you operate the agent at your domain | Anyone with DNS + `scripts/verify-oep-domain.ts` |
| **OEP Phase 2** — git evidence | The work you claim is backed by real commit history | Anyone fetching `GET /projects/:slug` |
| **OEP Phase 3** — signed evidence | The evidence is signed by the key only you control | Anyone with `scripts/verify-git-evidence.ts` |

The code is for everyone. The proof chain is yours alone.

---

## What it is not

- No bundled web UI — the human-facing front is [resume-agent-web](https://github.com/yuens1002/resume-agent-web), a separate repo you can also fork
- Not a resume builder SaaS.
- Not a static JSON file served from a CDN.
- Not a wrapper around a PDF.

---

## Companion projects

| Repo | What it is | Fork? |
|---|---|---|
| **[resume-agent-web](https://github.com/yuens1002/resume-agent-web)** | Human-facing web UI — conversational interface, job fit scorer, AI-readable JSON-LD + llms.txt. Points at `resume-agent` as its backend. | ✅ Yes — point two env vars at your own agent |
| **[OB1 (Open Brain)](https://github.com/NateBJones-Projects/OB1)** | Knowledge capture and storage layer — thoughts, embeddings, semantic search. Powers the `/query` grounding. | ✅ Yes |

The full stack for a self-sovereign professional agent: **OB1** captures your notes → **resume-agent** exposes them to AI systems → **resume-agent-web** gives humans a conversation surface.

---

## Truth contract — we walk the talk

When you fork this, your agent inherits four concrete commitments — enforced by code, prompt, and rubric, not aspirations:

1. **Every factual claim is cited inline.** Every claim about a project, capability, accomplishment, or employer carries a footnote-style marker (`[1]`, `[2]`, …). Every claim-bearing answer ends with a `Sources:` block mapping each marker to a specific corpus entry — `projects.<slug>`, `observations: "<excerpt>"`, `experience.<company>.bullets[N]`. The reader can audit which corpus entry backs which sentence without leaving the answer. Owned spec: [`docs/query-engagement-rules.md`](docs/query-engagement-rules.md).

2. **No fabrication — low confidence is the safe choice.** If the corpus doesn't directly answer the question, the agent says so. When evidence is partial, the agent picks `low` confidence and *names the gap*, never pads the gap with confident-sounding inference. The rubric in [`src/lib/eval-query-answer.ts`](src/lib/eval-query-answer.ts) catches the common failure modes — declines that trail into `Sunny led …` after saying `team size is not documented`, capability claims that overclaim the adjacent layer, binary answers that ship false claims.

3. **Third-person factual narration, not impersonation.** The agent reads from the candidate's documented work history and reports what it finds. It refers to the candidate by name or as "the candidate". It does not pretend to be the candidate. The asker is talking to an interface over a corpus, and the interface says so.

4. **Verifiable, not just claimed.** Every rule above is enforced in two places: the system prompt is composed from named `RULE_*` constants in [`src/lib/query-prompt.ts`](src/lib/query-prompt.ts), and the human-readable spec [`docs/query-engagement-rules.md`](docs/query-engagement-rules.md) mirrors those constants section-by-section (a unit test asserts they stay in sync). On top of that, the on-demand eval harness (`npm run eval:query`) runs ~16 fixture cases against a deterministic rubric with optional LLM-as-judge. Fork the repo, run the eval, watch the agent honor — or violate — each rule case-by-case. The truth claim is not on the honor system.

> If a claim isn't cited, it isn't made. If the corpus is silent, the agent says so. If the agent breaks these rules, the eval catches it.

---

## Architecture

```
[Local notes / recordings / Slack]
            |
            | nightly sync
            v
    Supabase Postgres + pgvector     ← data tier (DB only)
      thoughts table (private)
      public_profile table (read-only)
      job_applications, contacts, stages (private)
            ▲
            │ Supabase JS client
            │
   ┌────────┴────────────────────┐
   │   Railway (Hono app)        │  ← runtime tier — single deploy, your-agent-domain.com
   │                             │
   │   /mcp (PRIVATE)            │  Your AI tools: Claude Desktop, Cursor, etc.
   │   - Open Brain tools        │  - x-brain-key header or OAuth (claude.ai connector)
   │   - Job pipeline tools      │  - Stateless Streamable HTTP transport
   │                             │
   │   /public-mcp (PUBLIC)      │  Recruiter AI / screening agents
   │   - ask_candidate tool      │  - No auth, rate-limited per IP
   │                             │  - Stateless Streamable HTTP + streaming
   │                             │
   │   /query /match /info       │  Employer AI / QR scan (PUBLIC HTTP)
   │   /availability /projects   │  - Rate-limited per IP
   │   /resume (owner-only)      │  - /try → /query demo
   │   /.well-known/agent-card.* │  - A2A v1.0 autodiscovery (lists /public-mcp first)
   └─────────────────────────────┘
            ▲
            │ HTTP API (/info, /query, /match, etc.)
            │
   ┌─────────────────────────────┐
   │   resume-agent-web          │  ← human UI tier — your-domain.com (separate repo)
   │   (React + Hono, Vercel)    │
   │                             │
   │   Conversation interface    │  Human visitors — plain language Q&A
   │   Job fit scorer            │  Paste a JD, get a fit score
   │   JSON-LD + llms.txt        │  AI crawlers read profile directly from page
   └─────────────────────────────┘
```

> **This repo** is the backend (Railway). **[resume-agent-web](https://github.com/yuens1002/resume-agent-web)** is the frontend (Vercel). Both are independently forkable.

### Data tiers

| Table | Access | Purpose |
|---|---|---|
| `public_profile` | Public API (read-only) | Skills, experience, projects, availability |
| `thoughts` | Public-eligible read via `/query` + `/observations`; private (`metadata.private:true`) stays MCP-only | Two streams: `observation`/`idea`/`task` (the "why" — what `/observations` shows by default) and synced `reference` rows (the git/changelog ledger that grounds `/query` + `/resume`). Within the first stream, `metadata.source` separates hand-written notes (`mcp`) from machine entries (`sync`, `telemetry`) — surfaced as `authored` on `/observations` |
| `job_applications` + `application_stages` + `job_contacts` | MCP only (private) | Job hunt pipeline — applications, stage history, contacts |

Row Level Security in Supabase enforces the boundary. The public API has no knowledge of the private tables and no credentials to reach them.

### Latency optimization

`/query` is the hot path — retrieval + LLM generation. Both phases are instrumented (`llm_ms`, `retrieval_ms` persisted to `observed_queries`) and surfaced via `summarize_observed_queries`.

**Phase breakdown (uncached path):**

| Phase | What it measures | Typical share |
|---|---|---|
| `retrieval_ms` | Profile fetch + pgvector semantic search over OB1 thoughts | ~19% |
| `llm_ms` | `generateText` time — dominated by **output length**, not model speed | ~81% |
| overhead | Hono + JSON serialization | ~0% |

**What shipped (three levers, all live):**

1. **In-process response cache** — all `/query` responses are cached in memory keyed on `(normalized_question, style, caller_hint, profile.updated_at, ob1_thoughts_version)`. Cache hits return in 0ms. Two-dimensional invalidation: `profile.updated_at` changes on every profile mutation; `ob1_thoughts_version` (`MAX(updated_at)` over thoughts, 60s TTL) changes when new OB1 observations are captured. The cache covers all question types including behavioral — everything is cached after first hit per deploy.

2. **Per-category token caps** — `maxTokens` is set by question type rather than a flat 1024: binary questions cap at 300, behavioral at 1024 (they hit the ceiling), everything else at 600. Reduces generation time on the fast path without touching behavioral quality.

3. **Tighter follow-up suggestions** — reduced from 2–3 to 1–2 per response, saving ~30–50 tokens on every answer.

**Measured results (eval harness, 3 runs/case):**

| version | p50 | p95 | note |
|---|---|---|---|
| baseline (17 cases) | 2,471ms | 10,137ms | pre-optimization |
| +18th fixture | 3,183ms | 11,888ms | added long-output behavioral fixture |
| token caps + follow-ups | 2,407ms | 11,780ms | −24% from 18-case baseline |
| response cache (profile-only) | 0ms | 11,316ms | binary + overview + profile cached |
| **response cache (full, OB1 token)** | **0ms** | **320ms** | **all question types cached** |

Production verified: repeat hits on `Did you build resume-agent?`, `Show recent work`, `Tell me about Sunny`, and `How do you decide what features to build?` all return in 0ms after first call.

**The optimization discipline — correctness and latency measured together:**

`npm run eval:query -- --runs 3` measures both on a fixed 18-case fixture set. `--baseline` appends a row to [`docs/eval-baselines.md`](docs/eval-baselines.md) so git history shows which commit moved latency. The eval harness enforces that you can't win on speed by quietly degrading answers. See [`docs/plans/query-latency.md`](docs/plans/query-latency.md) for the full plan.

---

## Public API endpoints

### Advertised endpoints answer a GET

`llms.txt` and `robots.txt` publish these URLs to crawlers and LLM browse tools, which means the first thing that reaches them is a **GET** — including on the endpoints that only *do* anything on POST. A bare `404 Not Found` there is a broken promise to exactly the audience a machine-readable surface exists for: an agent that fetches an advertised URL to learn how to call it gets no method hint, no schema, no pointer to the working call.

So `POST /query`, `POST /match`, and `/public-mcp` each answer a plain GET with a **self-descriptor** — `endpoint`, `method`, `description`, `body`, `response`, `example` — at `200`. POST behaviour is untouched.

```bash
curl "https://your-agent-domain.com/match"       # → { endpoint, method: "POST", body: {…}, example: {…} }
curl "https://your-agent-domain.com/public-mcp"  # → transport, protocol, tools: [ask_candidate], example JSON-RPC call
```

`200` over the more literally correct `405` is deliberate: it matches what `GET /query` has always done and is friendlier to naive crawlers. **One exception** — a GET to `/public-mcp` carrying `Accept: text/event-stream` is a real MCP client trying to open the server→client SSE stream of Streamable HTTP. This server is stateless and offers no such stream, and the MCP spec says a server that doesn't SHOULD answer `405 Method Not Allowed`, so that caller gets `405` + `Allow: POST` — with the descriptor still in the body. Each caller gets the answer its protocol expects.

### `GET /.well-known/agent-card.json`
A2A v1.0-compliant agent card (canonical path per RFC 8615). `/.well-known/agent.json` redirects here (301).

```json
{
  "name": "<from Supabase public_profile.contact.name>",
  "description": "...",
  "version": "1.3.0",
  "supportedInterfaces": [
    {
      "url": "<baseUrl>/public-mcp",
      "protocolBinding": "MCP",
      "protocolVersion": "2025-03-26"
    },
    {
      "url": "<PUBLIC_URL env var, falls back to request origin>",
      "protocolBinding": "HTTP+JSON",
      "protocolVersion": "1.0"
    }
  ],
  "provider": {
    "organization": "<from Supabase public_profile.contact.name>",
    "url": "<PROVIDER_HOMEPAGE env var>",
    "contact": "<from Supabase public_profile.contact.email>"
  },
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "extensions": [
      {
        "uri": "<baseUrl>/.well-known/agent-card.json#api-docs",
        "description": "Custom API documentation, rate limits, and contact metadata.",
        "required": false,
        "params": {
          "rate_limits": { "requests_per_minute": 30, "scope": "per_ip" },
          "contact": { "email": "...", "calendly": "..." },
          "endpoints": {
            "info":         { "url": "<baseUrl>/info",         "method": "GET"  },
            "availability": { "url": "<baseUrl>/availability", "method": "GET"  },
            "query":        { "url": "<baseUrl>/query",        "method": "POST" },
            "match":        { "url": "<baseUrl>/match",        "method": "POST" },
            "projects":     { "url": "<baseUrl>/projects",     "method": "GET"  },
            "observations": { "url": "<baseUrl>/observations", "method": "GET"  }
          }
        }
      }
    ]
  },
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json", "text/plain"],
  "skills": [
    {
      "id": "query",
      "name": "Query Profile",
      "description": "Ask natural language questions about this candidate's skills, experience, and background.",
      "tags": ["resume", "profile", "skills", "experience"],
      "examples": ["What is your experience with TypeScript?", "..."]
    }
  ]
}
```

> **Note on `provider` field names:** The [official A2A proto spec](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto) uses `provider.name` and `provider.homepage`. The a2aregistry.org validator requires `provider.organization` and `provider.url` (both required). This card uses the registry's schema. See [Schema discrepancies](#schema-discrepancies) below.

### `GET /`
Serves the agent card JSON directly (alias for `/.well-known/agent-card.json`). Your deployed agent URL (e.g., `https://your-agent-domain.com`) becomes the short-form discovery URL once deployed.

### `GET /health`
Health check. Returns `{ "status": "ok" }` with `Cache-Control: no-store`. Exempt from rate limiting — safe to poll from uptime monitors.

### `GET /openapi.json`
OpenAPI 3.1.0 schema describing all six public endpoints (`/query`, `/match`, `/info`, `/availability`, `/projects`, `/observations`). Import this URL directly into ChatGPT's GPT builder (Actions → import from URL), Gemini Gems, or any platform that accepts OpenAPI for tool wiring. The `servers[0].url` is derived from the `PUBLIC_URL` env var — set it to your deployed domain.

### `GET /qr`
Returns a 300px QR code PNG. Target URL is controlled by the `QR_TARGET_URL` env var (e.g. a Custom GPT URL or your resume website). Falls back to `PUBLIC_URL` then the request origin if unset. Embed in any web page as a plain `<img>` tag:
```html
<img src="https://agent.yuens.me/qr" alt="Scan to chat" />
```

### `GET /info`
Full structured profile snapshot. Skills, experience, projects, education. No Claude call — raw data from `public_profile`. Fast, cacheable, suitable for ATS systems that want facts without NL processing.

### `GET /availability`
Current job-seeking status, preferred roles, start date, contact links.

### `GET /observations` · `GET /observations/:id`
Browsable list of the candidate's **public-eligible OB1 observations** — the dated reasoning and lessons behind the profile (the "why", not just the "what"). Each item is individually addressable at `GET /observations/:id`, so a premise can be cited as a stable, verifiable node — the human/agent-browsable companion to the semantic grounding `/query` already draws on ("the edge-resolver made browsable", in OEP evidence-graph terms).

**Authored "why", not the commit ledger.** By default this returns the *authored* reasoning types — `observation`, `idea`, `task` — and **excludes `type: reference`**, which is the git-to-OB1 sync's commit/changelog ledger ("what shipped"). That ledger still grounds `/query` and `/resume` semantically; it's just noise in a reflective browse. Pass `?type=reference` to read it explicitly. This keeps a clean split:

> **`/observations` = the authored *why*** · **`/verify` = the *proven what*** (Ed25519-signed git evidence per project, a different data path) · **`/query` grounds on both.**

**Authored notes vs machine entries.** `type` alone can't separate them: the nightly sync writes its own `type: "observation"` rows (VERSION DRIFT warnings), and the resume path writes rubric-failure telemetry the same way. Every item therefore carries **`authored`** — `true` for a hand-written note, `false` for a machine-generated sync/telemetry entry.

`?authored=1` / `?authored=0` filters on it server-side, applied *before* `limit` (so `?authored=1&limit=25` returns 25 authored notes rather than whatever survives filtering a mixed page). **The default listing is unchanged** — omitting the param returns both classes exactly as before, so nothing breaks for an existing consumer, and the `?type=reference` escape hatch keeps working.

The flag comes from an **allowlist** of authored `metadata.source` values (`mcp`, the private MCP `capture_thought` path), not a denylist of machine ones — so a machine writer added later is `authored: false` by default instead of silently passing as authored.

The filter is echoed in the response envelope **when it was requested**, which doubles as a **capability probe** on exactly the call a filtering client makes: `?authored=1` against a deployment predating this field silently returns the unfiltered list with a `200` and plausible JSON, and the absence of the key is the only way to tell that apart from a filter that was honored.

The envelope also carries `total` (how many matched the filters) and `truncated` (whether `limit` cut the list short), so a consumer can tell a complete page from a capped one instead of inferring it from `count`.

Private thoughts (`metadata.private: true`) are always excluded — the same boundary as `/query` — and a private or unknown id returns `404`, never `403` (the surface never confirms a private thought's existence). Filters: `?topic=` (OB1 tag, **case-insensitive** so casing variants resolve to one trail), `?type=` (override the default; e.g. `reference`), `?authored=` (`1`/`0`; omitted returns both), `?since=YYYY-MM-DD`, `?limit=` (1–500, default 25 — the ceiling is high enough for a sitemap generator to take every authored note in one request, since there's no browsing UI to paginate). Without `topic`, the listing is scoped to the `OBSERVATIONS_TOPICS` env (comma-separated, case-insensitive) when set, otherwise the most recent public observations. *Note: topic matching normalizes case but not synonyms — `OEP` and `Open Employment Protocol` are distinct tags; list both in `OBSERVATIONS_TOPICS` to union them in the default view.*

```bash
curl "https://your-agent-domain.com/observations?topic=OEP&limit=5"          # authored OEP trail
curl "https://your-agent-domain.com/observations?authored=1&limit=500"       # every authored note, one request
curl "https://your-agent-domain.com/observations?authored=0"                 # machine sync/telemetry entries
curl "https://your-agent-domain.com/observations?type=reference&topic=resume-agent"  # the changelog ledger
curl "https://your-agent-domain.com/observations/<id>"                       # one premise, by stable id
```

> Reference instance: `https://agent.yuens.me/observations` — live example to compare against.

### `GET /try`
Demo shortcut — redirects to `/query?question=Tell+me+about+yourself&stream=true`. Shareable CTA for humans and AI systems to see the agent in action.

### `POST /query` · `GET /query?question=`
Natural language question → structured JSON answer, or streaming plain text.

Answers are grounded in **two layers**: the structured `public_profile` (skills, employment bullets, projects — the snapshot) and a semantic search over the candidate's OB1 thoughts (project observations, tradeoffs, "why I built it this way", "when I stopped" — the lived experience). Behavioral and decision-making questions draw primarily on the second layer; when relevant thoughts are found, the top matches are injected into the prompt above the profile data. This is the same OB1 pattern `/resume` already uses, applied to the public query surface.

Response behavior follows an explicit [engagement-rules spec](docs/query-engagement-rules.md): **third-person factual narration** (the agent reads from the candidate's documented work history and reports what it finds — it does not impersonate the candidate), off-topic and no-data both decline factually ("outside the scope of the candidate's documented work history"), capability gaps are named precisely with adjacent layers (never overclaiming), adversarial-input refusal, no "on record" / database-y phrasing. **Every factual claim carries a footnote-style citation** (`[1]`, `[2]`, ...) and ends with a `Sources:` block mapping each marker to a corpus reference — "your agent is your truth" is auditable line-by-line. The cosine similarity threshold for thoughts retrieval is a coarse pre-filter; the system prompt's relevance rule decides which retrieved observations inform the answer.

> **Privacy:** thoughts are public-eligible by default. A thought flagged `metadata.private: true` is excluded from this surface at the database layer (`match_thoughts_public` RPC) — it stays visible only in the candidate's private MCP. Set the flag at capture time (`capture_thought` with `private: true`) or retroactively via SQL.

Request:
```json
{
  "question": "Has this person shipped production systems using TypeScript?",
  "context": "ATS screening for a senior backend role",
  "stream": false,
  "style": "cited"
}
```

**`style`** (optional, default `"cited"`):
- `"cited"` — full citation rules: inline `[N]` markers and a `Sources:` block in the answer string. Best for ATS, AI agents, and machine consumers.
- `"conversational"` — 2–4 plain prose sentences, no inline markers, attribution via `sources[]` array only. Best for human chat UIs. Also triggered by `x-agent-type: human` header.

Set `"stream": true` (or `?stream=true` on GET) to receive a plain text chunked response (`Content-Type: text/plain`) instead of JSON — stream mode always uses cited style.

Response (default, `stream: false`):
```json
{
  "answer": "...",
  "confidence": "high" | "medium" | "low",
  "sources": ["experience.company_name", "skills.languages", "observations"],
  "follow_up_suggestions": ["..."],
  "contact": { "email": "...", "calendly": "..." },
  "meta": { "model": "anthropic/claude-haiku-4.5", "latency_ms": 740 }
}
```

### `POST /match`
Feed a job description, get a fit assessment back. A **`GET /match`** returns a self-descriptor (method, body schema, response shape, example) rather than a 404 — see [Advertised endpoints answer a GET](#advertised-endpoints-answer-a-get).

Request:
```json
{
  "job_description": "..."
}
```

Response:
```json
{
  "fit_score": 0.82,
  "matched": ["TypeScript", "Postgres", "API design"],
  "gaps": ["Kubernetes", "Go"],
  "verdict": "strong match — 2 skill gaps are learnable, not blocking",
  "recommended_action": "apply"
}
```

### `POST /resume` _(private, key-protected)_
Feed a job description (and optional `framing_hints`), get back a tailored 2-page resume as structured JSON. This endpoint is for the candidate's own use — not exposed to employer agents.

**v2 behavior:** The endpoint generates two independent resumes in parallel, scores both against a deterministic 6-rule ATS rubric (title matching, keyword coverage, quantified bullets, authenticity, bullet prioritization, skills ordering), and returns the higher-scoring candidate. The response includes `_rubric` metadata with per-rule scores and a `jd_term_count` field — the number of unique extractable terms found in the submitted JD. Low `jd_term_count` (< 15) signals that the JD may be too thin for reliable keyword-dependent scoring; callers can use this to prompt users to enrich the JD before submitting. If neither generation passes the rubric threshold, a structured failure is logged to OB1 for pattern analysis. See [`docs/resume-pipeline-v2.md`](docs/resume-pipeline-v2.md) for architecture details.

---

## Agentic job match methodology

The `/match` endpoint is not a keyword matcher. It uses Claude to reason over the structured profile and the job description using the following decision flow:

1. **Extract the qualities this specific JD raises** — not a fixed checklist applied identically to every posting. For each quality (a skill, an experience characteristic like years/scope/recency, or a domain characteristic like industry/scale), the model records whether the JD states it as a hard requirement or a preference. A JD that never mentions company scale or a years-of-experience bar never gets scored on those axes; one that's explicit about them does.

2. **Score each extracted quality against the profile**:
   - verdict: matched, partial (adjacent), or missing
   - evidence grade: verified (backed by a dated project or employment record), claimed (prose only, no verifiable artifact), or absent

3. **Produce a fit score** (0.0 – 1.0) as a weighted average across every extracted quality — weighted by how much the JD emphasized it (required vs. preferred) and discounted when the supporting evidence is only claimed rather than verified. There is no fixed skills/experience/domain split; the weighting follows what each specific JD actually asked for.

4. **Classify the verdict**:
   - `>= 0.80`: strong match — apply as-is
   - `0.60 – 0.79`: partial match — note gaps, apply with tailored framing
   - `< 0.60`: weak match — gaps are blocking or require misrepresentation

5. **Surface gaps honestly.** The agent does not inflate fit scores. Gaps are reported as: learnable (tooling, framework), structural (years of experience, role type), or fundamental (domain, function).

The private `/resume` endpoint uses the same match methodology as context, then generates two independent resumes in parallel and selects the highest-scoring one via a deterministic rubric. The rubric enforces 6 ATS-informed rules: JD title mirroring, keyword coverage, quantified impact bullets, authenticity (no generic phrases), JD-aligned bullet prioritization, and skills ordering by relevance. See [`docs/resume-pipeline-v2.md`](docs/resume-pipeline-v2.md).

---

## Add as a custom connector in Claude

The public MCP endpoint lets any AI client with custom-connector support (claude.ai web + mobile, Claude Desktop, Cursor, etc.) ask natural-language questions about your candidate profile directly.

**Connector URL:** `https://your-agent-domain.com/public-mcp`

No authentication required. Rate-limited to 30 req/min per IP (shared bucket with the HTTP `/query` endpoint).

**Setup in claude.ai:** Settings → Connectors → Add custom connector → paste the URL above. Leave auth fields blank.

> **Mobile note:** Custom connectors must be **added from claude.ai on desktop** (web browser or Claude Desktop app). The mobile app can *use* connectors you've added but cannot *add* new ones. Once saved on desktop, the tool syncs automatically and appears in every new conversation on mobile.

**What to ask once connected:**

- "Does this candidate have production TypeScript experience?"
- "Score this candidate against the following JD: [paste]"
- "What are the candidate's three strongest projects?"

Responses come back grounded in the candidate's canonical published profile — the calling AI cannot fabricate answers "in the candidate's voice" as long as it goes through this connector.

The tool exposed is called `ask_candidate`. It's the only tool on the public MCP; all other structured-data endpoints (`/info`, `/availability`, `/match`, `/projects`) remain available as HTTP for clients that prefer raw JSON.

A plain `GET` on the connector URL returns a self-descriptor naming the transport, the tool, and its argument shape — see [Advertised endpoints answer a GET](#advertised-endpoints-answer-a-get). MCP clients are unaffected: a GET asking for the SSE stream still gets `405` + `Allow: POST`.

---

## Private agentic interface

You interact with your own knowledge base through Claude — no browser, no app, no local config required.

### claude.ai (web + mobile) — recommended

Add a custom connector at `claude.ai → Settings → Connectors → Add custom connector`:

| Field | Value |
|---|---|
| Remote MCP server URL | `https://your-agent-domain.com/mcp` |
| OAuth Client ID | your `OAUTH_CLIENT_ID` env var value |
| OAuth Client Secret | your `OAUTH_CLIENT_SECRET` env var value |

This connects via OAuth 2.0 Client Credentials flow. Works on web, phone, and Claude Desktop automatically — one connector, all surfaces.

### Claude Desktop (direct API access)

If you prefer a direct connection bypassing OAuth, add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "open-brain": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://your-agent-domain.com/mcp",
        "--header",
        "x-brain-key:YOUR_OPEN_BRAIN_KEY"
      ]
    }
  }
}
```

> **Windows:** Claude Desktop (Store app) reads from `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`, not the standard `%APPDATA%\Claude\` path.

Then in Claude:
> "Capture this: had a good call with Acme, following up Thursday"
> "What have I shipped in the last 6 months?"
> "Am I a good fit for this role? [paste JD]"
> "Log an application to Stripe — staff engineer, applied today"

### Available private MCP tools

The private `/mcp` endpoint exposes these tools for your personal use:

**Open Brain tools:**
- `search_thoughts` — Semantic search over your captured thoughts. Each result includes the row ID so you can target it with `update_thought` / `delete_thought`
- `list_thoughts` — List recent thoughts with filters (type, topic, person, time). Each row includes its ID
- `thought_stats` — Get summary stats of all thoughts (totals, types, top topics, people)
- `capture_thought` — Save a new thought with auto-generated embedding + metadata. Pass `private: true` to keep it out of the public `/query` and `/public-mcp` surfaces (default: public-eligible)
- `update_thought` — Edit an existing thought by ID. When `content` changes, the embedding and metadata are regenerated so semantic search stays consistent. The `private` flag and `source` are preserved from the existing row unless `private` is passed explicitly
- `delete_thought` — Permanently delete a thought by ID. No soft-delete
- `update_profile` — Update your public profile (summary, skills, employment, projects, education, availability, contact)
- `upsert_project` — Add or update a portfolio project by slug

**Job pipeline tools:**
- `score_match` — Score a job description against your profile
- `log_application` — Log a new job application (auto-scores if JD provided)
- `update_stage` — Move an application to a new stage (applied → phone_screen → technical → final → offer → rejected → withdrawn)
- `add_contact` — Add a recruiter or contact to an application
- `list_applications` — List your applications with filters
- `get_application` — Get full details of an application (contacts, stage history)
- `set_follow_up` — Set a follow-up date with notes
- `search_applications` — Search applications by company, role, JD, or notes

**Observability tools:**
- `summarize_observed_queries` — Get aggregated stats on public query traffic (MCP + HTTP). Useful for understanding how external AI clients are discovering and querying you.

Example queries:
> "Summarize the public query traffic for the last week"
> "Which ATS tools have been hitting me most this month?"
> "Show me the trend of questions over the past 7 days by day"

---

## Stack

| Layer | Technology |
|---|---|
| API framework | Hono (TypeScript) |
| AI | Vercel AI SDK via OpenRouter — Haiku (query/resume) + Sonnet (match) |
| Database | Supabase (Postgres + pgvector) |
| Private interface | MCP (Model Context Protocol) via OB1 |
| Validation | Zod |
| Deployment | Railway |
| Agent discovery | A2A v1.0 agent card spec (`/.well-known/agent-card.json`) |

---

## Security model

- All secrets in `.env.local`, never committed
- `public_profile` table: read-only, no auth required, rate-limited to 30 req/min per IP — bypassed for requests carrying a valid `Authorization: Bearer <API_KEY>` header
- `/resume` endpoint: when `AUTH_MODE=key`, requires `Authorization: Bearer <key>` header; when `AUTH_MODE=open` (default in `.env.example`), it is publicly accessible
- MCP server: OAuth 2.0 Client Credentials (claude.ai connector) or `x-brain-key` header (direct API / Claude Desktop)
- OAuth endpoints: `/authorize`, `/token`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` (RFC 8414 + RFC 9728)
- Origin header validation on MCP endpoint (DNS rebinding protection per MCP Streamable HTTP spec)
- Supabase service role key: server-side only, never returned to clients
- Postgres Row Level Security enforces public/private table boundary
- No personal data in this repo — data lives in your Supabase instance

---

## OEP domain verification

The first step toward the [Open Employment Protocol](docs/plans/oep-phase-1-domain-verification.md): prove that whoever runs the agent also controls the domain it claims to represent. The agent publishes an Ed25519 public key; the domain's DNS publishes that key's fingerprint. Anyone can confirm the two match.

This is the "self-signed cert" moment — no third-party certificate authority, no signing yet, just a one-shot domain-ownership proof that future OEP work (signed agent cards, invocation receipts, employment co-signatures) builds on top of.

### Set it up once

1. Generate a keypair:
   ```bash
   npx tsx scripts/generate-oep-keypair.ts
   ```
   The script prints three things: the env vars to paste into Railway (`OEP_PUBLIC_KEY`, `OEP_PRIVATE_KEY`, `OEP_KEY_ISSUED_AT`) and a TXT record value.

2. Paste the env vars into Railway. The private key never leaves Railway; the public key powers `/.well-known/oep-public-key.json`.

3. Publish the printed TXT record at `_oep.<your-root-domain>` in your DNS provider. Example:
   ```
   _oep.your-domain.com.  300  IN  TXT  "v=oep1; alg=ed25519; fp=<base64url-fingerprint>"
   ```

4. Once Railway has redeployed with the env vars and DNS has propagated, verify:
   ```bash
   npx tsx scripts/verify-oep-domain.ts your-domain.com
   ```
   The script does a DNS lookup, fetches `https://agent.<domain>/.well-known/oep-public-key.json`, recomputes the fingerprint from the raw key bytes, and confirms all three values agree. Exit 0 on PASS, exit 1 on FAIL with a one-line reason.

### What anyone else can do with it

A third party — recruiter agent, employer system, curious peer — runs the same `verify-oep-domain.ts` script (or its equivalent) against your domain. A PASS proves the agent at `agent.<domain>` is operated by whoever controls `<domain>` at the DNS level. That's the foundation OEP builds on.

The agent card's `provider.identity.fingerprint` field surfaces the same value so card-aware clients have it without a separate DNS lookup.

> **Phase 1 scope.** No signing of responses or cards yet. No `/verify?receipt=…` endpoint. No key rotation. Those are subsequent plans — see [docs/plans/a2a-trust-layer.md](docs/plans/a2a-trust-layer.md) for the broader picture.

---

## `/query` engagement rules & eval

`/query` and `/public-mcp ask_candidate` answer per an explicit spec: [`docs/query-engagement-rules.md`](docs/query-engagement-rules.md). Third-person factual narration (the agent refers to the candidate by name or as "the candidate", never impersonates); every factual claim carries a footnote-style `[N]` citation with a `Sources:` block at the end of the answer; off-topic, no-data, and adversarial questions all resolve to a single factual-decline posture; capability gaps are named precisely with adjacent layers (never overclaiming); `on record` / `in the database` phrasing is forbidden. The cosine similarity threshold for thoughts retrieval (default `0.35`, overridable via `QUERY_THOUGHTS_THRESHOLD`) is just a coarse pre-filter — the system prompt's `RULE_OBSERVATIONS_RELEVANCE` decides which retrieved thoughts actually inform the answer.

On-demand eval harness in [`scripts/eval/run-eval.ts`](scripts/eval/run-eval.ts) — runs ~16 fixture cases across six categories (binary, capability, behavioral, off_topic, adversarial, no_data — including two fabrication-bait cases that test the agent declines instead of confabulating from adjacent data), scores each with a deterministic rubric (blocking correctness gates + additive quality rules) and an optional `--judge` LLM-as-judge pass. **Not** in `test:unit` (it calls the LLM); same posture as `compare-prompts.ts`. Run with `.env.local` populated.

```bash
# Run the whole suite — deterministic rubric only, no extra LLM cost beyond /query calls
npm run eval:query

# Try a single case (see scripts/eval/query-eval-cases.ts for ids)
npm run eval:query -- --case behavioral-decide-features
npm run eval:query -- --case capability-aws
npm run eval:query -- --case adversarial-ignore-instructions

# Run one category
npm run eval:query -- --category off_topic

# Sweep the threshold — does the new prompt absorb a looser pre-filter?
npm run eval:query -- --threshold 0.5
npm run eval:query -- --threshold 0.35

# Add the LLM-as-judge rule (one Haiku call per case) — spot-checks the
# semantic stuff the deterministic rules can't read (overclaim, real redirect)
npm run eval:query -- --judge

# Latency: run each case N times, report median-of-N per phase + p50/p95 aggregate.
# Majority-vote across the N runs also stabilizes correctness (kills behavioral
# single-run variance), so the recorded pass rate is trustworthy.
npm run eval:query -- --runs 3

# Record a baseline row (date, version, pass rate, p50/p95) to docs/eval-baselines.md
# so git history shows which commit moved latency. Record from a clean run.
npm run eval:query -- --runs 3 --baseline
```

Read the per-case `PASS/FAIL — <rule>: <detail>` lines, then the category summary, the overall score, and the **latency report** (p50/p95 for total / llm / retrieval, plus the slowest cases). The harness measures correctness **and** latency on one fixed set, so latency is only ever optimized with the pass rate held — see [`docs/plans/query-latency.md`](docs/plans/query-latency.md) and the recorded snapshots in [`docs/eval-baselines.md`](docs/eval-baselines.md).

The route classifier has its own golden-set eval (`npm run eval:route` — 112 spec-labeled cases, result-cached for dev iteration, weekly CI gate). It can run against two backends with genuinely different behavior — the production OpenRouter path (the gate) and a free local Claude-CLI path (dev tool only). Which runs where, and the empirically-established reasons why, are documented in [`docs/eval-environments.md`](docs/eval-environments.md).

---

## Workflow

See [`docs/workflow.md`](docs/workflow.md) for a walkthrough of how employer AI systems, recruiters, and the candidate each interact with the agent — including an honest account of what works today vs. what's still aspirational.

---

## Project sync

`npm run sync` keeps every project in your `public_profile.projects` array up-to-date from GitHub — no configuration needed beyond what's already in the profile.

**How it works:** For each project that has a `repo` field pointing to a GitHub URL, the sync script:

1. Fetches the README and CHANGELOG and reconciles `architecture` and `highlights` via LLM semantic diff
2. **Infers `status`** from last-push activity — projects pushed within 60 days become `active`; dormant for > 1 year become `archived`
3. **Infers `url`** from the GitHub repo homepage field or deployment URL patterns in the README (only fills if the field is empty — never overwrites a manually-set URL)
4. **Infers `tech`** from `package.json` dependencies — maps package names to canonical display names and merges additively with existing entries
5. Extracts new OB1 thoughts for downstream semantic retrieval

Projects without a GitHub `repo` are skipped silently. Fields that need human framing (`description`, `problem`, `role`, `impact`, `cover`) are never touched by the sync.

**Employment consolidation (opt-in):** Active self-employment generates a continuous stream of granular technical evidence — individual changelogs mention specific UX patterns, state machines, modal states, and API shapes. Useful as raw signal, but too narrow as employment bullets. The nightly sync distills this stream into accurate, broader-scope bullets backed by shipped evidence — replacing "built a modal" with "engineers complex financial flows with non-dismissable state machines" when the body of work supports it.

Set `EMPLOYMENT_SYNC_ENABLED=true` in Railway to automatically apply the best proposal to the self-employed entry on a configurable schedule. The consolidation runs a rubric gate (no generic phrases, quantified-metric ratio must not regress) before applying. A notification thought is written to OB1 after each update so you can audit what changed via `search_thoughts "employment updated"` in your private MCP.

| Env var | Default | Options |
|---|---|---|
| `EMPLOYMENT_SYNC_ENABLED` | `false` | `true` to enable |
| `EMPLOYMENT_SYNC_STRATEGY` | `replace` | `replace` \| `additive` |
| `EMPLOYMENT_SYNC_FREQUENCY` | `weekly` | `weekly` \| `on_change` \| `always` |
| `EMPLOYMENT_SYNC_MIN_BULLETS` | `3` | minimum bullet count to accept |
| `EMPLOYMENT_SYNC_RUBRIC_GATE` | `true` | `false` to skip banned-phrase + metric check |

**Controlling what appears on the resume:** Not every synced project belongs in the Projects section of a generated resume. Some projects are better represented as context for the employment section (e.g. a SaaS platform that's already covered by a self-employment entry). Use `HIDE_FROM_PROJECTS` to exclude specific slugs from the resume output at generation time — the project continues to sync and its OB1 thoughts continue to flow into employment bullet context.

```bash
# .env.local
HIDE_FROM_PROJECTS=artisan-roast-platform

# comma-separated to hide multiple
HIDE_FROM_PROJECTS=artisan-roast-platform,internal-tool
```

The filter runs server-side before the LLM prompt is built. OB1 thoughts from hidden projects are unaffected and continue to be injected as employment context via semantic search.

> **Breaking change (v0.3.0):** `SYNC_REPOS` has been removed. The sync script now derives repos directly from `profile.projects[].repo`. Remove `SYNC_REPOS` from your `.env.local` and Railway env vars — it is no longer read.

### Automated sync via GitHub Actions

The included `.github/workflows/sync.yml` runs `npm run sync` on a nightly schedule so your profile stays current without any manual intervention. It also supports on-demand runs from the GitHub UI or CLI — no local setup or OS-specific scheduler needed.

**To enable:**

1. Add these secrets to your GitHub repository (**Settings → Secrets and variables → Actions**):

   | Secret | Value |
   |---|---|
   | `SUPA_PROJECT_URL` | Your Supabase project URL |
   | `SUPA_SERVICE_ROLE` | Your Supabase service role key |
   | `OPENROUTER_API_KEY` | Your OpenRouter API key |

   > `GITHUB_TOKEN` is provided automatically by GitHub Actions — no setup needed.

2. The workflow runs at **2am UTC daily**. To change the cadence, edit the `cron` expression in `.github/workflows/sync.yml`:

   ```yaml
   - cron: '0 2 * * *'   # daily at 2am UTC
   - cron: '0 2 * * 1'   # weekly on Monday
   - cron: '0 */6 * * *' # every 6 hours
   ```

3. To trigger an immediate sync from anywhere: **GitHub → Actions → Nightly project sync → Run workflow**.
   From the CLI: `gh workflow run sync.yml`

---

## Setup

1. Clone this repo
2. `npm install`
3. Set up a Supabase project and run migrations: `npm run db:link && npm run db:push`
4. Set up OB1 on the same Supabase project (see [OB1 docs](https://github.com/NateBJones-Projects/OB1))
5. Copy `.env.example` → `.env.local` and fill in your keys
6. Seed your profile: `npm run seed`
7. `npm run dev`
8. Deploy to Railway (connect the repo — `railway.toml` handles build + start)
9. Set env vars in Railway dashboard (see `.env.example` for the full list)
10. Set `QR_TARGET_URL` in Railway to the URL you want the QR to point to (e.g. your resume website or a Custom GPT URL). `GET /qr` on your deployed domain generates the QR automatically — embed it anywhere as an `<img>` tag.
11. _(Optional)_ Set `OBSERVATIONS_TOPICS` (comma-separated OB1 topic tags) to scope the default `GET /observations` listing to a curated trail (e.g. `OEP,Open Employment Protocol,employment`). Unset, the endpoint lists your most recent public-eligible observations. Private thoughts are never included.

---

## Submitting to A2A registries

Once your instance is live and `/.well-known/agent-card.json` is reachable, submit to any of these:

### [a2aregistry.org](https://a2aregistry.org) — API
```bash
curl -X POST https://a2aregistry.org/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{"wellKnownURI": "https://your-domain/.well-known/agent-card.json"}'
```
The registry fetches your card and validates it. Conformance status is re-checked every 30 minutes.

### [a2agent.net](https://a2agent.net/agent-registry) — UI
Visit the registry, find the register/submit option, and enter your `/.well-known/agent-card.json` URL.

### [prassanna-ravishankar/a2a-registry](https://github.com/prassanna-ravishankar/a2a-registry) — GitHub PR
Community-driven open-source directory. Open a PR adding your agent card URL to their directory.

### Schema discrepancies

The A2A ecosystem has multiple validators and registries, and they don't all agree with the [official proto spec](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto). Known differences as of April 2026:

| Field | Official proto spec | a2aregistry.org validator |
|---|---|---|
| Provider name | `provider.name` (required) | `provider.organization` (required) |
| Provider website | `provider.homepage` (optional) | `provider.url` (**required**) |
| Interface array | `supportedInterfaces` (required) | not validated |
| Skill input/output modes | `inputModes` / `outputModes` (optional) | **required** lists (can be empty) |
| Skill examples | `examples` (optional) | **required** list (can be empty) |
| `capabilities.stateTransitionHistory` | not in spec | **required** boolean |

This card uses `provider.organization` and `provider.url` to satisfy the registry. The `PROVIDER_HOMEPAGE` env var maps to `provider.url` — it must be set or the registry will reject the card.

---

## Project status

Reference instance live at [agent.yuens.me](https://agent.yuens.me) — all public endpoints operational. Fork and deploy your own: [Setup](#setup).

See [ROADMAP.md](ROADMAP.md) for what's shipped and what's in progress. Design docs for in-flight work live in [docs/plans/](docs/plans/).

Contributions welcome — particularly around the job match scoring methodology and MCP tool definitions.

---

## License

MIT — fork freely, deploy your own instance, build on top of it. See [LICENSE](LICENSE).

The code is open. Your identity proof (OEP domain fingerprint, signed evidence) is yours. A fork of this repo is a new agent, not a copy of you.
