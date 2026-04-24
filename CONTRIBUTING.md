# Contributing

Conventions for anyone contributing to this repo — use whatever editor, AI assistant, or toolchain you prefer.

---

## Project shape

Hono app on Railway, Supabase Postgres + pgvector as the data tier. See [README.md](README.md) for the vision, [ROADMAP.md](ROADMAP.md) for shipped + in-progress work.

- **Runtime:** Node 20+, Railway single replica (stateless — horizontal scale is safe)
- **Language:** TypeScript strict. No `any` — use `unknown` + type guards
- **Framework:** Hono, routes in `src/routes/`
- **AI:** Vercel AI SDK via OpenRouter; model selection in `src/lib/ai.ts`
- **Validation:** Zod at system boundaries (HTTP handlers, MCP tool inputs)
- **Database:** Supabase JS client; migrations in `supabase/migrations/` with timestamp-prefixed filenames (`YYYYMMDDHHMMSS_name.sql`)

---

## Documentation conventions

Documentation is split by **state, not topic**.

| Directory | Contents | Lifecycle |
| --- | --- | --- |
| `docs/` root | Reference docs for **shipped** features. Present-tense — describes current behavior. | Update when behavior changes |
| `docs/plans/` | Design docs for **proposed or in-progress** features. Future-tense — explains *why* and *how*. | Stays as historical record after shipping; a plan merges before implementation |
| `ROADMAP.md` (root) | Status log — shipped, in-progress, next | Append on each PR; keep concise |
| `CHANGELOG.md` (root) | Version history, achievement-framed | One line per PR, newest first, under `## [Unreleased]` |

A plan is merged before implementation begins. After the feature ships, **the plan stays put** — it's a historical record of the decision process. The equivalent reference doc in `docs/` root gets updated separately to describe the live behavior.

### Plan doc structure

Every `docs/plans/*.md` should have these sections, in order:

1. **Title + Branch + Status + Scope** (header block)
2. **Context** — what exists today, what problem this solves
3. **Goals** — numbered list
4. **Non-goals** — explicit exclusions
5. **Architecture** — diagram or prose showing where the change lands
6. **Implementation shape** — ordered steps with file paths
7. **Decisions locked from planning session** — numbered with rationale
8. **Acceptance criteria** — `AC-N: description` format, grouped by concern (transport, behavior, schema, docs, regression). Every AC automatable where possible; exceptions annotated (`smoke-only`, `manual`, etc.).
9. **Rollback** — one-command revert path
10. **What this unlocks** — downstream capabilities

---

## Acceptance criteria

- Format: `AC-N: description` where `N` is a monotonic integer (AC-1, AC-2, …)
- Group ACs by concern (transport, behavior, schema, docs, regression)
- Every AC maps to a runnable test where possible — exceptions must be annotated
- Test names reference the AC number: `it('AC-15: row exists with all fields populated', ...)`
- Test files live in `tests/` matching feature scope (`tests/<feature>-transport.test.ts`, `tests/<feature>-tool.test.ts`, shared fixtures in `tests/helpers/<feature>.ts`)

---

## Code conventions

- **Shared core logic first** — if a feature has both HTTP and MCP surfaces, extract the core into a pure function (no Hono Context, no MCP server handle) and have both thin wrappers call it. Example: `queryProfile()` in `src/routes/query.ts` is called by both the POST handler and the `ask_candidate` MCP tool.
- **Fire-and-forget logging** — observability writes (e.g. `observed_queries`) must swallow errors. Logging must never break the response path.
- **Stateless transports** — MCP routes construct a fresh server + transport per request. No session map, no GC, no TTL. Session IDs stripped from responses.
- **Auth at the route boundary**, not inside handlers. Use `authenticate(c)` helpers.
- **Origin allowlist** for DNS rebinding protection per MCP Streamable HTTP spec.
- **CORS allow-methods** should match the actual methods registered on each route (e.g. a POST-only route advertises `POST, OPTIONS` — don't leak `GET, DELETE`).

---

## Test conventions

- **Runner:** Node's `node:test` via `tsx --test`. No Jest.
- **Dotenv:** `config({ path: '.env.local' })` at the top of every test file
- **Env vars:** `MCP_URL`, `QUERY_URL`, `AGENT_CARD_URL`, `OPEN_BRAIN_KEY`, `SUPA_PROJECT_URL`, `SUPA_SERVICE_ROLE`, `PORT` — all configurable with sensible `localhost` defaults
- **DB verification:** query Supabase directly via a shared `getSupabase()` helper. For fire-and-forget writes, **poll** with retries — not flat `setTimeout`
- **Cleanup:** use a unique per-run marker (e.g. `__test_${feature}_${Date.now()}__`) embedded in test data; clean up via `after()` hook filtering on the marker
- **Cost-sensitive tests** (LLM calls, rate-limit exhaustion): gate behind an env flag or `it.skip` by default

---

## Commits and PRs

- Conventional commits: `type(scope): description` — lowercase, present tense, no period
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`
- **Impact-first messages**: "eliminate false-positive dedup that blocked all new listings" > "update dedup logic"
- Docs-only changes can skip verification hooks (`git commit --no-verify`)
- CHANGELOG.md updated per PR (one line under `## [Unreleased]`), `package.json` version bumped (`npm version patch --no-git-tag-version`)
- PR flow: open PR → review → address comments → resolve threads → squash-merge

---

## Project principles

1. **Canonical data over inferred data.** Every response the public endpoints generate is grounded in the candidate's published profile — never fabricated by the LLM.
2. **Additive changes, never breaking.** New endpoints, new agent-card entries, new tools — old consumers keep working.
3. **Forkable by default.** Any engineer should be able to clone, point at their own Supabase + Railway, seed a profile, and have a queryable agent in under 30 minutes.
4. **Evidence over assertion.** Every PR includes tests that exercise the real code path. Mocks are acceptable during TDD but get replaced with integration tests before merging.

---

## Where to put things (quick reference)

| What | Where |
| --- | --- |
| New HTTP route | `src/routes/<name>.ts` |
| New MCP tool (private) | Register in `src/routes/mcp.ts` `buildServer()` |
| New MCP tool (public) | Register in `src/routes/public-mcp.ts` `buildPublicServer()` |
| Shared route helpers | `src/lib/mcp-common.ts` (CORS headers, origin check) |
| Shared business logic | `src/lib/<name>.ts` (pure functions, no framework deps) |
| Agent card changes | `src/routes/agent-card.ts`; bump card version on any schema change |
| DB schema change | `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` — additive preferred |
| Reference docs for shipped features | `docs/<name>.md` |
| Design docs for proposed features | `docs/plans/<name>.md` |
| Shared test fixtures | `tests/helpers/<feature>.ts` |
| Test files | `tests/<feature>-<layer>.test.ts` |
