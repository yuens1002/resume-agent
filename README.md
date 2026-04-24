# resume-agent

[![Agent QR Code](qr.png)](https://agent.yuens.me/.well-known/agent-card.json)

> Scan to load the live agent card — then paste it into any AI and start asking questions, or [open it directly](https://agent.yuens.me/.well-known/agent-card.json).

A machine-queryable AI agent that represents a professional profile. No UI. Two access tiers: a public HTTP API for employer AI systems, and a private MCP server for personal interaction.

Built on top of [OB1 (Open Brain)](https://github.com/NateBJones-Projects/OB1) by Nate B. Jones — OB1 handles the knowledge capture and storage layer; this project handles the public-facing agentic interface and job match methodology.

---

## Why this exists

AI systems are increasingly the first pass in hiring. ATS tools, qualification agents, and personal AI assistants are being used to screen candidates before a human ever looks at a resume. This project meets that reality head-on: expose a structured, queryable endpoint that any AI system can interrogate, and give the candidate (you) a private agentic interface to interact with the same knowledge base — generating tailored resumes, scoring job fit, and managing the job hunt pipeline.

The public endpoint is not a portfolio site. It is not a chatbot. It is an agent that answers questions about professional history with structured, machine-readable JSON that downstream systems can act on.

**Your agent is your truth.** When a recruiter's AI asks "does this person know Python?" without your agent, it *infers* an answer from training-data patterns — fabricating a plausible-sounding profile from nothing. With your agent, the AI calls your canonical endpoint and responses are grounded in the data *you* publish and control. The individual owns the narrative AI systems tell about them — the interface-less neural link that keeps AI honest about you.

---

## What it is not

- No web UI. No dashboard. No frontend.
- Not a resume builder SaaS.
- Not a static JSON file served from a CDN.
- Not a wrapper around a PDF.

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
   │   Railway (Hono app)        │  ← runtime tier — single deploy, agent.yuens.me
   │                             │
   │   /mcp (PRIVATE)            │  Your AI tools: Claude Desktop, Cursor, etc.
   │   - Open Brain tools        │  - x-brain-key header or OAuth (claude.ai connector)
   │   - Job pipeline tools      │  - Stateless Streamable HTTP transport (v0.2.14+)
   │                             │
   │   /query /match /info       │  Employer AI / QR scan (PUBLIC)
   │   /availability /projects   │  - Rate-limited per IP
   │   /resume (owner-only)      │  - /try → /query demo
   │   /.well-known/agent-card.* │  - A2A v1.0 autodiscovery
   └─────────────────────────────┘
```

### Data tiers

| Table | Access | Purpose |
|---|---|---|
| `public_profile` | Public API (read-only) | Skills, experience, projects, availability |
| `thoughts` | MCP only (private) | Raw notes, captures, work-in-progress |
| `job_applications` + `application_stages` + `job_contacts` | MCP only (private) | Job hunt pipeline — applications, stage history, contacts |

Row Level Security in Supabase enforces the boundary. The public API has no knowledge of the private tables and no credentials to reach them.

---

## Public API endpoints

### `GET /.well-known/agent-card.json`
A2A v1.0-compliant agent card (canonical path per RFC 8615). `/.well-known/agent.json` redirects here (301).

```json
{
  "name": "<from Supabase public_profile.contact.name>",
  "description": "...",
  "version": "1.0.0",
  "supportedInterfaces": [
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
            "projects":     { "url": "<baseUrl>/projects",     "method": "GET"  }
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

### `GET /info`
Full structured profile snapshot. Skills, experience, projects, education. No Claude call — raw data from `public_profile`. Fast, cacheable, suitable for ATS systems that want facts without NL processing.

### `GET /availability`
Current job-seeking status, preferred roles, start date, contact links.

### `GET /try`
Demo shortcut — redirects to `/query?question=Tell+me+about+yourself&stream=true`. Shareable CTA for humans and AI systems to see the agent in action.

### `POST /query` · `GET /query?question=`
Natural language question → structured JSON answer, or streaming plain text.

Request:
```json
{
  "question": "Has this person shipped production systems using TypeScript?",
  "context": "ATS screening for a senior backend role",
  "stream": false
}
```

Set `"stream": true` (or `?stream=true` on GET) to receive a plain text chunked response (`Content-Type: text/plain`) instead of JSON — useful for demo surfaces and human-readable interfaces.

Response (default, `stream: false`):
```json
{
  "answer": "...",
  "confidence": "high" | "medium" | "low",
  "sources": ["experience.company_name", "skills.languages"],
  "follow_up_suggestions": ["..."],
  "contact": { "email": "...", "calendly": "..." },
  "meta": { "model": "anthropic/claude-haiku-4.5", "latency_ms": 740 }
}
```

### `POST /match`
Feed a job description, get a fit assessment back.

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

**v2 behavior:** The endpoint generates two independent resumes in parallel, scores both against a deterministic 6-rule ATS rubric (title matching, keyword coverage, quantified bullets, authenticity, bullet prioritization, skills ordering), and returns the higher-scoring candidate. The response includes `_rubric` metadata with per-rule scores. If neither generation passes the rubric threshold, a structured failure is logged to OB1 for pattern analysis. See [`docs/resume-pipeline-v2.md`](docs/resume-pipeline-v2.md) for architecture details.

---

## Agentic job match methodology

The `/match` endpoint is not a keyword matcher. It uses Claude to reason over the structured profile and the job description using the following decision flow:

1. **Extract requirements** from the JD: required skills, preferred skills, years of experience, domain knowledge, role type (IC, lead, manager), culture signals.

2. **Score against profile** by category:
   - Technical skills: exact match, adjacent, or gap
   - Experience depth: years, scope, recency
   - Domain overlap: industry, product type, scale
   - Role alignment: what the candidate has led vs. contributed to

3. **Produce a fit score** (0.0 – 1.0) weighted as:
   - Required skills coverage: 50%
   - Experience alignment: 30%
   - Domain overlap: 20%

4. **Classify the verdict**:
   - `>= 0.80`: strong match — apply as-is
   - `0.60 – 0.79`: partial match — note gaps, apply with tailored framing
   - `< 0.60`: weak match — gaps are blocking or require misrepresentation

5. **Surface gaps honestly.** The agent does not inflate fit scores. Gaps are reported as: learnable (tooling, framework), structural (years of experience, role type), or fundamental (domain, function).

The private `/resume` endpoint uses the same match methodology as context, then generates two independent resumes in parallel and selects the highest-scoring one via a deterministic rubric. The rubric enforces 6 ATS-informed rules: JD title mirroring, keyword coverage, quantified impact bullets, authenticity (no generic phrases), JD-aligned bullet prioritization, and skills ordering by relevance. See [`docs/resume-pipeline-v2.md`](docs/resume-pipeline-v2.md).

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

## Workflow

See [`docs/workflow.md`](docs/workflow.md) for a walkthrough of how employer AI systems, recruiters, and the candidate each interact with the agent — including an honest account of what works today vs. what's still aspirational.

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
10. Generate a QR code pointing to `https://your-domain/.well-known/agent-card.json`

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

Live at [agent.yuens.me](https://agent.yuens.me). All public endpoints are operational.

Contributions welcome — particularly around the job match scoring methodology and MCP tool definitions.

---

## License

MIT
