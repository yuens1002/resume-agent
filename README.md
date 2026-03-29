# resume-agent

![Agent QR Code](qr.png)

> Scan to load the live agent card — then paste it into any AI and start asking questions.

A machine-queryable AI agent that represents a professional profile. No UI. Two access tiers: a public HTTP API for employer AI systems, and a private MCP server for personal interaction.

Built on top of [OB1 (Open Brain)](https://github.com/NateBJones-Projects/OB1) by Nate B. Jones — OB1 handles the knowledge capture and storage layer; this project handles the public-facing agentic interface and job match methodology.

---

## Why this exists

AI systems are increasingly the first pass in hiring. ATS tools, qualification agents, and personal AI assistants are being used to screen candidates before a human ever looks at a resume. This project meets that reality head-on: expose a structured, queryable endpoint that any AI system can interrogate, and give the candidate (you) a private agentic interface to interact with the same knowledge base — generating tailored resumes, scoring job fit, and managing the job hunt pipeline.

The public endpoint is not a portfolio site. It is not a chatbot. It is an agent that answers questions about professional history with structured, machine-readable JSON that downstream systems can act on.

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
      OB1 (Supabase)
  Postgres + pgvector
  thoughts table (private)
  public_profile table (read-only)
            |
     -------+-------
     |               |
     v               v
MCP Server      Resume Agent API
(PRIVATE)       (PUBLIC)

Your AI tools   Employer AI / QR scan
Claude Desktop  POST /query
Cursor, etc.    GET /info
Key-protected   GET /availability
Full read/write GET /.well-known/agent.json
                POST /match
                POST /resume
                Read-only, rate-limited
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

### `GET /.well-known/agent.json`
A2A-compliant agent card. The QR code points here. AI systems use this to autodiscover the query endpoint, capabilities, and contact info.

### `GET /info`
Full structured profile snapshot. Skills, experience, projects, education. No Claude call — raw data from `public_profile`. Fast, cacheable, suitable for ATS systems that want facts without NL processing.

### `GET /availability`
Current job-seeking status, preferred roles, start date, contact links.

### `POST /query`
Natural language question → structured JSON answer powered by Claude.

Request:
```json
{
  "question": "Has this person shipped production systems using TypeScript?",
  "context": "ATS screening for a senior backend role"
}
```

Response:
```json
{
  "answer": "...",
  "confidence": "high" | "medium" | "low",
  "sources": ["experience.company_name", "skills.languages"],
  "follow_up_suggestions": ["..."],
  "contact": { "email": "...", "calendly": "..." },
  "meta": { "model": "claude-haiku-4-5-20251001", "latency_ms": 740 }
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
Feed a job description, get back a tailored 2-page resume as structured JSON (renderable to PDF). This endpoint is for the candidate's own use — not exposed to employer agents.

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

The private `/resume` endpoint uses the same methodology to generate a resume that leads with matched qualifications, reframes experience toward the role's language, and omits irrelevant history — without fabricating credentials.

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
        "x-brain-key:YOUR_MCP_ACCESS_KEY"
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
| AI | Anthropic SDK — Haiku (query/resume) + Sonnet (match) |
| Database | Supabase (Postgres + pgvector) |
| Private interface | MCP (Model Context Protocol) via OB1 |
| Validation | Zod |
| Deployment | Railway |
| Agent discovery | A2A agent card spec (`/.well-known/agent.json`) |

---

## Security model

- All secrets in `.env.local`, never committed
- `public_profile` table: read-only, no auth required, rate-limited by IP
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
10. Generate a QR code pointing to `https://your-domain/.well-known/agent.json`

---

## Project status

Live at [agent.yuens.me](https://agent.yuens.me). All public endpoints are operational.

Contributions welcome — particularly around the job match scoring methodology and MCP tool definitions.

---

## License

MIT
