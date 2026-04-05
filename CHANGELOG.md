# Changelog

## [Unreleased]

## [0.2.4] — 2026-04-05

- 2026-04-05 — fix(sync): correct artisan-roast-platform owner to dev-yuen-agency; guard undefined skill items in buildCandidateStack; tighten ProfileRow types

## [0.2.3] — 2026-04-05

- 2026-04-05 — feat(sync): GitHub-to-OB1 project sync — fetch READMEs, update project architecture, rebuild CANDIDATE_STACK thought

- 2026-04-03 — chore(config): rename MCP_ACCESS_KEY to OPEN_BRAIN_KEY across all files and tests

- 2026-04-03 — feat(resume): add optional framing_hints parameter to /resume endpoint

- 2026-04-03 — fix(mcp): add 30s SSE keepalive ping to prevent Railway/Fastly idle-timeout dropping connections

- 2026-04-03 — feat(mcp): switch to SSE streaming transport — session map with 10-min TTL, GET stream handler, proper DELETE teardown, numReplicas=1 in railway.toml

- 2026-04-02 — fix(agent-card): full A2A v1.0 spec audit — add `supportedInterfaces` (replaces top-level `url`; carries `protocolBinding` and `protocolVersion`), add `provider` (name, homepage, contact), move `rate_limits`/`endpoints`/`contact` into `capabilities.extensions`, remove non-spec `stateTransitionHistory` from capabilities

- 2026-04-02 — fix(routing): make `/.well-known/agent-card.json` the canonical A2A path (RFC 8615); redirect `/.well-known/agent.json` → `agent-card.json` (was reversed)

- 2026-04-02 — fix(agent-card): add required `version` field, remove non-spec `schema_version` and `auth` fields per A2A protocol spec

- 2026-04-02 — fix(agent-card): conform capabilities to A2A protocol spec (object with streaming/pushNotifications), add required defaultInputModes, defaultOutputModes, and skills fields

- 2026-04-01 — fix(agent-card): add output_schema, auth, rate_limits; remove invalid required: false from context property

- 2026-04-01 — feat(api): add robots.txt allowlisting AI crawlers (GPTBot, ClaudeBot, Grok, etc.)

- 2026-04-01 — feat(resume): use configurable RESUME_MODEL env var, default to openai/gpt-4o-mini, increase maxTokens to 4096

- 2026-04-01 — fix(config): correct OpenRouter model IDs to dot-notation format (claude-haiku-4.5, claude-sonnet-4.6)

- 2026-04-01 — feat(query): add streaming support and owner rate-limit bypass, add /try demo redirect

- 2026-04-01 — refactor(ai): consolidate all providers to OpenRouter, remove @ai-sdk/anthropic and @ai-sdk/google

- 2026-03-30 — refactor(mcp): normalize extractMetadata + getEmbedding to Vercel AI SDK, add score_match + upsert_project integration tests

- 2026-03-30 — refactor(match): extract scoreMatch to lib, register score_match + upsert_project MCP tools

- 2026-03-29 — fix(api): redirect /.well-known/agent-card.json to /.well-known/agent.json for Google A2A compatibility
- 2026-03-29 — chore(mcp): add public/private visibility guidance and voice reference notes to update_profile tool
- 2026-03-29 — feat(mcp): add update_profile tool — closes OB1 → public profile sync loop

- 2026-03-29 — docs(readme): add live QR code pointing to agent.yuens.me/.well-known/agent.json

- 2026-03-29 — docs(readme): update MCP section to Railway+OAuth, add job pipeline to data tier table, expand security model

- 2026-03-29 — fix(mcp): enforce Origin validation, add GET→405 and DELETE→200 per MCP Streamable HTTP spec

- 2026-03-29 — feat(oauth): add client_credentials grant so claude.ai custom connectors can authenticate with client_id + client_secret

- 2026-03-29 — fix(mcp): enable JSON response mode to fix SSE streaming incompatibility in Node.js
- 2026-03-29 — fix(mcp): create new McpServer per request to fix 500 on concurrent connections
- 2026-03-29 — fix(oauth): add RFC 9728 protected-resource metadata and WWW-Authenticate header on 401
- 2026-03-29 — feat(mcp): port open-brain MCP server to Railway with Auth Code + PKCE OAuth for claude.ai support
- 2026-03-29 — feat(pipeline): add job hunt pipeline — 3 tables, 7 MCP tools, auto-scoring, integration tests
- 2026-03-29 — docs(readme): clarify auth headers — /resume uses `Authorization: Bearer <key>`, MCP uses x-brain-key
- 2026-03-28 — fix(mcp): replace non-existent server-fetch package with mcp-remote, add Windows config path note
- 2026-03-28 — docs(workflow): genericize workflow doc — remove personal names/details from examples
- 2026-03-28 — docs(workflow): add workflow doc covering employer AI, candidate MCP, and real-world A2A limitations
- 2026-03-28 — feat(api): add IP-based rate limiting (30 req/min), fix README discrepancies, add ResumeResponse type
- 2026-03-26 — feat(ob1): add Open Brain MCP server as Supabase Edge Function with thoughts table, pgvector search, and 4 MCP tools
- 2026-03-26 — feat(query): support GET /query?question= as fallback for GET-only AI agents
- 2026-03-26 — chore(config): pin Node.js to >=20 via engines field and railway nixpacks variable
- 2026-03-26 — fix(agent-card): enrich endpoint objects with method, schema, and examples for AI agent discovery
- 2026-03-26 — chore(api): add startup log confirming route registration
- 2026-03-26 — fix(api): disable hono strict mode to handle trailing slash variants without 404
- 2026-03-26 — fix(query): add GET handler for endpoint discovery to prevent 404 on non-POST requests
- 2026-03-25 — chore(profile): enrich artisan roast project data with ai tooling and accurate details
- 2026-03-25 — chore(profile): add email and calendly to contact seed data
- 2026-03-25 — chore(deploy): add railway config, seed script, and supabase cli
- 2026-03-24 — feat(projects): add /projects endpoint with rich project schema and seed data
- 2026-03-23 — feat(api): add hono server with resume, profile, match, and query routes
