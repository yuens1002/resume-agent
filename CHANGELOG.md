# Changelog

## [Unreleased]

- 2026-03-26 — feat(query): support GET /query?question= as fallback for get-only ai agents
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
