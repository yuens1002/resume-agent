# How resume-agent works

Three actors interact with this system: **employer AI systems** (or the humans who run them), **the candidate** (whoever deployed this instance), and the **API** as the mediator between them. This document walks through each perspective — including what works today and what doesn't yet.

---

## Employer AI / ATS workflow

An AI system or recruiter tool can interact with the agent entirely through HTTP, with no custom integration required.

### Step 1 — Discover the agent

```
GET https://agent.yuens.me/.well-known/agent.json
```

Returns an A2A-compliant agent card: name, capabilities, full endpoint catalog with schemas and examples, and contact info. Designed to be machine-parseable so AI systems can learn what to call and how.

### Step 2 — Read the profile

```
GET https://agent.yuens.me/info
```

Full structured snapshot: skills by category, employment history with bullets, education, projects, availability. No AI call — raw data, fast, cacheable. Good for ATS tools that want facts without NL processing.

```
GET https://agent.yuens.me/availability
```

Current job-seeking status, preferred roles, remote preference, and contact links.

### Step 3 — Ask a question

```
POST https://agent.yuens.me/query
Content-Type: application/json

{
  "question": "Has this person shipped production TypeScript systems?",
  "context": "ATS"
}
```

Response:
```json
{
  "answer": "Yes, extensively. The candidate has shipped multiple production TypeScript systems across diverse domains: a full-stack Next.js application, an open-source e-commerce platform with 118 API routes, and this Resume Agent API (Node.js/Hono/TypeScript). TypeScript is listed as a core language skill and appears across all recent projects.",
  "confidence": "high",
  "sources": [
    "employment.Company A.bullets[1]",
    "employment.Self-Employed.bullets[1]",
    "projects.E-Commerce Platform.tech",
    "projects.Resume Agent.tech",
    "skills.Languages"
  ],
  "follow_up_suggestions": [
    "Ask about type safety practices or how TypeScript improved code quality in a specific project",
    "Inquire about experience with advanced TypeScript patterns (generics, utility types, discriminated unions)",
    "Ask about the scale of TypeScript systems shipped — number of files, routes, or models"
  ],
  "contact": {
    "email": "candidate@example.com",
    "calendly": "https://calendly.com/candidate/intro"
  },
  "meta": {
    "model": "claude-haiku-4-5-20251001",
    "latency_ms": 3788
  }
}
```

The `context` field is optional and is treated as a free-form hint about who's asking. Suggested values include `"ATS"`, `"recruiter"`, `"ai-agent"`, but any short descriptor string is allowed. The agent adjusts tone and verbosity based on this hint.

### Step 4 — Score a job description

```
POST https://agent.yuens.me/match
Content-Type: application/json

{
  "job_description": "Senior Frontend Engineer, React and TypeScript required, 5+ years experience, remote"
}
```

Response:
```json
{
  "fit_score": 0.81,
  "matched": ["TypeScript"],
  "gaps": ["React (partial)"],
  "verdict": "Strong overall fit on experience and TypeScript, but React is secondary to Vue in the candidate's profile — present and used in multiple roles, though not the primary framework.",
  "recommended_action": "apply",
  "scoring": {
    "skills": {
      "matched": ["TypeScript"],
      "partial": ["React"],
      "missing": [],
      "score": 0.75
    },
    "experience": {
      "years": 1,
      "scope": 1,
      "recency": 1,
      "score": 1
    },
    "domain": {
      "industry": 0.6,
      "product_type": 0.7,
      "scale": 0.7,
      "score": 0.67
    }
  }
}
```

`fit_score` is computed deterministically from the model's categorical judgments — not a hallucinated decimal. Scoring weights: skills 50%, experience 30%, domain 20%.

`recommended_action` thresholds:
- `apply` — score ≥ 0.80
- `apply-with-tailoring` — score 0.60–0.79
- `pass` — score < 0.60

---

## Candidate workflow (private MCP interface)

You interact with your own knowledge base through Claude Desktop or Cursor — no browser, no app. See the [MCP config in README](../README.md#private-agentic-interface) for setup.

Once connected, the 4 available tools are:

| Tool | What it does |
|---|---|
| `capture_thought` | Save a note — plain text, metadata (type, topics, people, action items) extracted automatically |
| `search_thoughts` | Semantic search by meaning — "find thoughts about accessibility work" |
| `list_thoughts` | Chronological list with filters by type, topic, person, or date range |
| `thought_stats` | Aggregate view — total count, distribution by type/topic/people |

**Common workflows:**

```
"Capture this: had a good call with the DealerOn recruiter today, they're looking for a Vue lead, follow up Thursday"

"Search for anything about testing or QA work I've shipped"

"Am I a good fit for this role? [paste JD]"

"Generate a resume for this staff engineer position at Stripe [paste JD]"
```

The last two trigger Claude to call `GET /info` and `POST /match` / `POST /resume` against the live API (including the required `Authorization: Bearer` header for `/resume`, or anonymously only when `AUTH_MODE=open`), using your captured context to enrich the response.

---

## What actually works today

The A2A agent card spec is designed for a world where AI systems auto-discover and query agents. That world isn't fully here yet.

| Scenario | Status | Notes |
|---|---|---|
| Claude Desktop with MCP | ✅ Works | Full private interface — capture, search, match, resume |
| Claude.ai (Web) with WebFetch | ✅ Works | Can call endpoints directly if given the URL |
| Cursor / AI coding assistants | ✅ Works | Via MCP or manual HTTP calls |
| Custom employer AI agent | ✅ Works | If they're given the agent card URL to target |
| Consumer phone AI apps (Gemini, ChatGPT) | ❌ No HTTP | These apps have no mechanism to make GET/POST requests |
| A2A auto-discovery | ❌ Not yet | No mainstream consumer app supports `/.well-known/agent.json` discovery |
| Fabricated responses | ⚠️ Common | Apps that can't call the API often hallucinate a plausible-sounding profile instead |

**The practical gap:** Most consumer AI apps — the ones a recruiter might open on their phone — cannot make outbound HTTP requests. They'll either fail silently or invent a scenario ("this candidate would be...") rather than querying the real data. The conversational interview experience the agent card enables doesn't work in these contexts.

**What actually reaches the agent:** Developer tools (Claude, Cursor), purpose-built ATS platforms, and anyone given the URL and a terminal.

---

## QR code workflow (practical alternative for in-person use)

Since auto-discovery doesn't work in consumer apps, the fallback is manual but still useful:

1. QR code → `https://agent.yuens.me/.well-known/agent.json`
2. Scan surfaces the full agent card JSON
3. Paste the card into any AI conversation as context
4. Ask questions — the AI reasons over the structured profile without needing to call the API

This works in any AI app that accepts pasted text, which is all of them. It's less elegant than auto-discovery but it's reliable today.

The agent card is also human-readable enough that a recruiter can skim it directly and follow the `calendly` link to book time.
