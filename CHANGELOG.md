# Changelog

## [Unreleased]

- 2026-07-29 — **BREAKING** (public API default) feat(observations): first-class `authored` signal separating hand-written notes from machine-generated entries (#222) — `GET /observations` mixed two classes of item under one `type: "observation"`: the dated authored reasoning trail the endpoint's own `note` advertises, and machine writes that happen to share the type (the nightly sync's `VERSION DRIFT` warnings, `src/routes/resume.ts`'s `RESUME_RUBRIC_FAILURE` telemetry). `?type=` couldn't separate them, so the frontend was filtering client-side on a topic/length heuristic — a consumer guessing at producer shape, and the reason per-observation pages were deferred. Every item now carries `authored: true|false`, with a matching server-side `?authored=1|0` filter applied *before* the `limit` slice (so `?authored=1&limit=25` returns 25 authored notes, not the remainder of a mixed page). The flag comes from an **allowlist** of authored `metadata.source` values (`AUTHORED_THOUGHT_SOURCES = ['mcp']`, the private MCP `capture_thought` path) rather than a denylist of machine ones: a denylist has the same failure mode as the heuristic it replaces — a machine writer added later silently passes as authored — whereas an allowlist leaves it `authored: false` until explicitly listed. A missing `source` is likewise not authored, which matches the data (all 148 source-less public rows in the live table are machine telemetry from writers predating the convention; zero authored notes lack it). Producer-side, the rubric-failure write now stamps `source: 'telemetry'` so its classification is explicit rather than resting on an absent field. **BREAKING — the default listing changed: `GET /observations` now returns hand-authored notes only.** Previously it returned authored notes and machine entries mixed together. Any consumer that wants the old behaviour must pass `?authored=all`; `?authored=0` returns machine entries alone. This is a public, documented endpoint — advertised in `llms.txt`, `openapi.json`, and the A2A agent card, with a `robots.txt` that names nine crawlers as welcome — so unknown consumers may exist; the change was made anyway because this surface is crawled (server-rendered into a sitemap), a crawler arriving with no query params is the common case rather than the edge one, and the endpoint's own `note` has always described itself as "the dated, authored reasoning trail" — the mixed default was arguably the bug. The authored default applies only *within* the authored layer: an explicit `?type=` outside it (`reference`, `review_needed`, `notification`) returns both classes, since those are machine-written by definition and filtering them to authored-only would empty rather than filter them — which would have silently broken the documented `?type=reference` escape hatch while the response `note` kept advertising it. An explicit `?authored=` always wins over that inference. The envelope also gained `total` and `truncated` so a consumer can distinguish a complete page from a capped one instead of inferring it from `count`, and the handler now logs when a fetch hits `FETCH_CEILING` — which surfaced a pre-existing, unrelated issue: the `reference` ledger is at 3,485 rows against a 1,000-row window, so `?type=reference&topic=…` already misses older matches (the stale comment claiming otherwise is corrected, the underlying paging fix is not in scope here). The applied filter is always echoed in the envelope, which doubles as a capability probe: the key is absent on any deployment predating this field, so a client can distinguish "the server applied my filter" from "the server silently ignored an unknown param" — otherwise indistinguishable, since an ignored param still returns 200 with plausible JSON. `?limit` ceiling raised 100 → 500 in the same pass: with the topic scope widened there are ~174 authored notes, the consumer is a single server-rendered page with no pagination UI, and the query already fetches up to `FETCH_CEILING` rows so a wider in-memory slice costs nothing. openapi schema + README updated, 8 new unit tests

- 2026-07-24 — feat(profile): shared profile cache with stale-on-error failover — motivated by the 2026-07-24 outage where a transient Railway→Supabase network failure (each fetch hung ~20s, then got a Cloudflare HTML error page back) turned every profile-backed endpoint into a 404 for ~3 hours while the data itself was intact. New `src/lib/profile-cache.ts` is now the single place that fetches the canonical `public_profile` row: 5-min fresh TTL (extracted from `query.ts`'s previously route-local cache), an 8s fetch timeout via `.abortSignal` so requests fail fast instead of hanging, last-known-good failover (a failed fetch serves the cached row marked `stale` and keeps retrying live on every request), and a truthful `not_found` vs `unavailable` split — only PostgREST's zero-rows code (PGRST116) maps to 404 "Profile not found"; every transport failure is now 503 "Profile temporarily unavailable" via the shared `PROFILE_ERROR_HTTP` registry. All ten read sites (`/query` + stream, `/info`, `/availability`, `/projects` ×2, `/verify/git-evidence`, `/resume`, `/match` via `scoreMatch` (new `ProfileUnavailableError`), agent card, public-mcp website lookup) go through it; write paths (`PATCH /profile`, `update_profile`/`upsert_project`/`upsert_publication` MCP tools) call `invalidateProfileCache()` so updates surface immediately instead of after the old 5-min window (upsert read-modify-write fetches stay direct-to-DB — they must read fresh to avoid clobbering). Also stops `/observations` echoing raw upstream `error.message` bodies (a full Cloudflare HTML page was publicly visible during the outage) — bounded `console.error` + generic 503 body instead. 9 new unit tests (`tests/profile-cache.test.ts`, clock pinned via `t.mock.timers`)

- 2026-07-13 — fix(eval): stop leaking the candidate's real name into eval fixtures and public arbitration issues — `scripts/eval/query-eval-cases.ts`'s `mustNotClaim` overclaim check had a hardcoded literal name in source (superseding the earlier #202 fork-local-literal design call), now built from `CANDIDATE_NAME_TOKEN` and substituted with the real derived name at score time (`ruleCapability` in `src/lib/eval-query-answer.ts` now takes `candidateName`); `scripts/eval/judge-sweep.ts` now redacts the candidate's real name to `DEFAULT_CANDIDATE_NAME` ("Alex") in every production question pulled from `observed_queries` — before dedupe, before the judge call, before the stdout report, and before it ever reaches the public GitHub arbitration issue body — via a new `redactCandidateName` helper (`scripts/eval/judge-sweep-lib.ts`, reusing `eval-query-answer.ts`'s now-exported `escapeRegExp`). This also fixes a latent dedupe inconsistency: `route-cases.ts` already stores promoted questions with the real name swapped for "Alex" by convention, so redacting incoming questions the same way keeps both sides of the dedupe comparison on the same footing. Retroactively redacted the one standing open arbitration issue (#214) to match

- 2026-07-13 — feat(query): add data-driven pronouns field for third-person voice — `RULE_VOICE` only ever told the model to refer to the candidate by name or "the candidate", with no guidance on which pronoun to use for back-reference within a sentence, so the model defaulted to singular "they/their" for every fork regardless of the candidate's actual pronouns. New optional `contact.pronouns` field (e.g. `"he/him"`) on `PublicProfile`, a `deriveCandidatePronouns` helper mirroring `deriveCandidateName`'s no-op-token-by-default pattern (`CANDIDATE_PRONOUNS_TOKEN` / `DEFAULT_CANDIDATE_PRONOUNS` falls back to neutral "they/them" when unset), and `buildSystemPrompt` now threads the derived value into `RULE_VOICE`. Data-driven, not hardcoded — every OSS fork sets its own `contact.pronouns` or gets the safe neutral default. Live profile updated via `update_profile` MCP tool

- 2026-07-13 — fix(query): suppress follow-up suggestions on no-data/off-topic declines (#215) — `follow_up_suggestions` was a pure LLM output field with no deterministic post-processing; the v2 contract ("the decline is the answer; no follow-up offers") is prompt-only guidance, and the model didn't reliably comply for the no-data case since its sibling gap examples (binary, capability) are worked with non-empty `follow_up_suggestions`. New shared `src/lib/decline-phrases.ts` (`isDeclineShapedAnswer`, extracted from the eval rubric's `FACTUAL_DECLINE_PHRASES` so both the live route and the eval scorer use one definition) forces `follow_up_suggestions: []` in `query.ts` whenever the answer matches a factual-decline shape — deterministic post-processing instead of a prompt edit, per the #177c2 finding that `query-prompt.ts` rule-text edits have a track record of displacing unrelated behavior. Weekly eval's no_data category: 2/4 → 4/4, no new failures elsewhere (route eval 336/336 unchanged, unit tests 472/472)

- 2026-07-11 — fix(query): HIDE_FROM_PROJECTS now applies to /query, not just /resume (#176 direction 3) — parsing/filtering extracted to shared `src/lib/hidden-projects.ts` (one mechanism, two consumers); hidden projects are physically dropped from the injected projects array (composed with #175's shown_projects removal, count heading follows); with the env var unset the built prompt is byte-identical to before (verified against origin/main with an adversarial unicode fixture); closes the privacy-adjacent half of #176 — a project hidden from resumes can no longer be surfaced or fabricated-about via /query. NOTE for local dev: `.env.local` sets HIDE_FROM_PROJECTS, so local eval baselines need `HIDE_FROM_PROJECTS=` (empty-string override; dotenv won't un-set it). The general cross-reference fabrication half stays open on #176, recommended to fold into #165

- 2026-07-11 — refactor(query): candidate-name decoupling for OSS forks (#202) — the few-shot examples and rule text in `buildSystemPrompt` interpolate the candidate name derived from `profile.name` instead of hardcoding the owner's; eval scoring regexes build their name alternation dynamically (Unicode-safe lookaround boundaries so non-ASCII fork names like José/孙 match correctly; `escapeRegExp` + $-pattern-immune substitution); proven zero-behavior-change via sha256 byte-identity of the built prompt for the live profile across all 4 mode/style combos (the [#177c2 prompt-attention finding](https://github.com/yuens1002/resume-agent/issues/177) is why byte identity was the gate); eval-cases + docs marked fork-local-by-design per the issue's option; PROMPT_VERSION hash value shifts (module-load hashes the token form) — verified harmless, per-process in-memory cache only

- 2026-07-11 — fix(eval): judge rubric round 2 (#197 residuals) — post-quota judged run came back 15/18 with every deterministic rule passing; the three misses were judge blind spots: the required binary "Yes"/"No" opener misread as first-person, progressive disclosure misread as an incomplete answer, and the `follow_up_suggestions` field (where the "offer the rest" rule is actually satisfied) invisible to the judge — the NOT-violations block gains both rules and `buildJudgePrompt` now surfaces follow-ups; binary + overview re-judged clean (overview 4/4 twice)

- 2026-07-11 — fix(query): kill the deterministic parse_error/500 family + salvage misplaced Sources trailers (#197 chunks A+B, closes #193) — `isBinaryQuestion` no longer misfires on "Have you ever …" (the `ever` exclusion restores retrieval + the higher token cap for #193's exact phrasing); `generateWithLengthRetry` retries once at `min(cap*2, 2048)` when `finishReason === 'length'` instead of serving an unclosed-JSON 500; behavioral cap 1024→1536 (answers now carry 10+ citations from 8 retrieved thoughts); parse_error logs finally include `finishReason`; `salvageTrailingSourcesBlock` reattaches a `Sources:` block the model emitted outside the JSON envelope (capability-kubernetes's confirmed shape) for both HTTP and MCP paths

- 2026-07-11 — fix(eval): rubric + judge calibration (#197 chunks C+D) — `NAMES_COUNT_RE` accepts spelled counts (the rule's own example phrase "seven active projects" previously failed the rule's check); the blocking anti-pattern phrase check is category-scoped per RULE_GAPS (behavioral/overview narratives may say "in the database" about a product's own database; decline categories keep the full list); the query judge runs on `EVAL_JUDGE_MODEL ?? anthropic/claude-sonnet-4.5` instead of haiku-judging-haiku, with an explicit NOT-violations rubric block (name = third person; bare corpus paths = documented citation format; gap-then-adjacent = documented pattern); `buildQueryPrompt` names the live project count in the profile-data heading so the model stops miscounting 7 as "six"

- 2026-07-11 — feat(eval): weekly judge sweep over production traffic (#205) — `scripts/eval/judge-sweep.ts` pulls the last 8 days of distinct `observed_queries`, dedupes against the golden set and the standing arbitration issue (fence-safe question round-tripping — a question containing its own ``` block can't corrupt the markdown or defeat dedupe), judges the delta with sonnet on `OPENROUTER_API_KEY_EVAL`, and files judge-vs-production disagreements to a labeled arbitration issue instead of a red X (exit 1 reserved for infrastructure errors); sibling workflow `eval-judge-sweep.yml` rides the weekly schedule; first live dry-run: 129 rows → 40 distinct → 35 new → 10 disagreements

- 2026-07-11 — feat(profile): publication record type + upsert_publication mcp tool + read surfaces (#177 chunk 1) — `Publication` interface (slug-keyed, optional `signature` reusing the existing evidence-signing type) and a `publications` jsonb column on public_profile; `upsert_publication` on the private MCP mirrors upsert_project's find-by-slug upsert with the merge logic extracted to `src/lib/publications.ts` for connection-free unit testing (5 new tests, 416 total); publications ride `GET /info` automatically and the openapi schema names the field. `/query` citations are chunk 2.

- 2026-07-11 — feat(ci): weekly eval gate on the production serving path; retire nightly cadence (#201 phase b) — one Monday workflow (eval-weekly.yml) gates the route golden set on the prod default model, re-judges it with sonnet, and runs the query eval with LLM-as-judge, all on the isolated `OPENROUTER_API_KEY_EVAL` (a full run costs well under $1); the nightly workflow is deleted (owner decision: change volume doesn't warrant daily gating). The subscription CLI provider stays local-dev-only — live CI runs proved its free-text decoding measurably noisier than production's enum-forced path on narrate/narrate_fit boundaries (three cases annotated `cli_unstable` with round-level evidence), and the CLI self-updated mid-eval corrupting a run (now guarded by `DISABLE_AUTOUPDATER` + a 120s spawn timeout)

- 2026-07-11 — feat(eval): result cache + claude-code provider + key isolation for eval runs (#201 phase a) — route-eval verdicts cache to a committed JSON keyed by hash(rule+question+model+provider+round), so label-only changes replay free and rule edits auto-invalidate; `--provider claude-code` runs the classifier through the local Claude CLI (subscription, not metered API); eval scripts prefer `OPENROUTER_API_KEY_EVAL` so an eval burn can never exhaust the production key's monthly cap again (the incident that took prod down twice on 2026-07-11)

- 2026-07-11 — feat(query): narrate_fit route + fit_question response flag (#199) — the classifier's three-way route surfaces "this narrated answer was about fit" so resume-agent-web renders its deterministic fit-check chip without re-guessing from text; fit questions get a 1536-token ceiling that overrides the binary heuristic (fixes live parse_error 500 on "Is [name] a fit for X?" phrasings); observed_queries logs fit_question for the judge sweep

- 2026-07-11 — feat(query): classify action intent via dedicated pre-pass instead of in-generation tool-calling (#195) — open_match_tool routing moves from an AI-SDK tool exposed during answer generation to classifyRoute() run in parallel with retrieval; tool-route short-circuits deterministically, narrate-route never sees a tool (kills the #194 misfire class); public-mcp rewrites tool intents into a narrated pointer (#183); observed_queries logs the route decision; legacy action_intent eval category removed (route eval owns routing coverage)

- 2026-07-10 — feat(eval): route-classifier golden set (112 spec-labeled cases) + nightly baseline run, and the classifier module it asserts (#195) — includes the owner-decided spec pivot (tool only on résumé intent or explicit procedure invocation; fit QUESTIONS narrate), judge validation via `--model`, and drops the hardcoded `--env-file=.env.local` that broke the nightly eval in CI (#184)

- 2026-07-10 — fix(query): default all callers to cited style, closing the one reproducible open_match_tool misfire (conversational style + human caller-hint) found in #191 — resume-agent-web's sanitizeAnswer already strips citation markers unconditionally, so this changes reliability only, not visible output

- 2026-07-10 — feat(observability): log OpenRouter provider + finish_reason on /query responses; add durable regression tests for #188's never-cache-action_intent behavior

- 2026-07-10 — fix(query): never cache action_intent-bearing responses — a single non-deterministic bad roll was getting frozen and served to every visitor

- 2026-07-10 — fix(query): add prompt-version dimension to response cache key — fixes stale pre-#181 cached responses still serving live

- 2026-07-10 — fix(query): require independent role-signal and fit-request checks for open_match_tool (#182)
- 2026-07-09 — fix(query): tighten open_match_tool routing against work/project phrasing (#180)
- 2026-07-09 — feat(query): real tool-calling for action-intent routing (#174 backend) — open_match_tool signal, action_intent response field
- 2026-07-09 — feat(eval): add action_intent eval category (#174 acceptance spec) and nightly regression-watch cadence
- 2026-07-09 — fix(query): enforce shown_projects exclusion server-side instead of trusting the model
- 2026-07-01 — feat(projects): add urlLabel field for custom demo button text
- 2026-06-30 — fix(query): raise cited token ceiling to 1024 — fixes parse error on exhaustive project listings
- 2026-06-30 — fix(prompt): require remainder chip on every partial-listing response, not just the first
- 2026-06-29 — fix(query): raise conversational token floor to 800 — fixes bookie card missing from multi-project responses
- 2026-06-29 — fix(query): raise token cap for conversational behavioral questions and add error logging
- 2026-06-29 — refactor(config): simplify db:push to use psql directly instead of supabase CLI binary
- 2026-06-29 — fix(config): db:push loads connection string from .env.local via tsx wrapper script
- 2026-06-29 — feat(profile): add tagline field to public profile (nullable text column, MCP tool param, OpenAPI schema); fallback chain implemented in resume-agent-web
- 2026-06-10 — feat(query): add project_slugs field and shown_projects context convention for stateless project disclosure
- 2026-06-10 — fix(mcp): coerce skipChangelog to boolean for MCP string serialization
- 2026-06-09 — fix(sync): add skipChangelog, docsPath, featureDocsGlobs to upsert_project schema so sync escape hatches are actually stored in Supabase
- 2026-06-09 — ci(sync): opt into Node.js 24 for actions runner via FORCE_JAVASCRIPT_ACTIONS_TO_NODE24

## [0.4.60] - 2026-06-09

- 2026-06-09 — feat(sync): add skipChangelog flag — gates highlights reconciliation, changelog thought extraction, and version drift detection per project; featureDocsGlobs thoughts and architecture sync unaffected; document in SYNC-CONVENTION.md

- 2026-06-09 — fix(query): remove trailing CTA from answer prose — follow-up invitations belong exclusively in `follow_up_suggestions`, not the answer string; fixes #156
- 2026-06-09 — fix(query): enumerate-then-count for progressive disclosure — state total after listing to prevent count/bullet divergence; fixes #156
- 2026-06-09 — fix(sync): swap GITHUB_TOKEN for GH_PAT so nightly sync can read private repos outside resume-agent
- 2026-06-09 — fix(sync): version drift detection — warns via OB1 thought when package.json is ahead of latest CHANGELOG section by >1 patch or any minor/major; deduped by content hash
- 2026-06-09 — docs(sync): add SYNC-CONVENTION.md covering what syncs, keep-a-changelog convention, per-repo escape hatches, and downstream fork guidance

- 2026-06-07 — docs(readme): update latency optimization section — documents shipped cache (phase breakdown, 3 levers, baseline progression table, production verification), replaces pre-optimization numbers

- 2026-06-07 — perf(query): OB1 version token — adds thoughts MAX(updated_at) as second cache key dimension (60s TTL); all question types now cached; behavioral p95 drops from 11316ms to 320ms; eval 18/18 pass p50 0ms p95 320ms

- 2026-06-07 — chore(eval): record baseline with extended response cache — 18/18 pass, p50 0ms (cache hits dominate), p95 11316ms (behavioral ceiling unchanged)

- 2026-06-07 — perf(query): extend response cache to all profile-only answers — cache any question whose sources contain no "observations" entries; fetch profile first so cache check skips retrieval+LLM entirely on hit; "Tell me about Sunny" / "Show recent work" / "What are Sunny's strengths?" go 7s→0ms on repeat; eval p50 0ms, 18/18 pass

- 2026-06-07 — perf(query): in-process response cache for binary questions — key (normalized_question, profile.updated_at), auto-invalidates on profile mutations, capped at 200 entries; eval binary cases hit 0ms median on runs 2+, full suite 18/18 pass

- 2026-06-06 — perf(query): per-category maxTokens (300 binary / 1024 behavioral / 600 all else) + reduce follow_up_suggestions to 1–2; eval p50 −24% (3183→2407ms), p95 flat at 11780ms, 18/18 pass

- 2026-06-05 — chore(eval): record baseline with 18 cases — 18/18 pass, p50 3183ms, p95 11888ms; previous flake (behavioral-hard-tradeoff cites-source) resolved by majority-vote; p50/p95 now honest with long-output behavioral fixtures included

- 2026-06-04 — docs(latency): add response caching as Stage 3 investigation area — deterministic queries (~25% of traffic) keyed on question_hash + profile_version, bust on profile mutations

- 2026-06-04 — docs(readme): add latency optimization section to architecture — phase breakdown table, optimization discipline, eval/production gap explanation; add long-output behavioral eval fixture drawn from real production traffic

- 2026-06-04 — feat(observability): expose llm_ms/retrieval_ms phase breakdown in summarize_observed_queries — avg split %, p50/p75/p95 per phase, coverage count; updates ObservedQuery type and DB select; fixed small-sample percentile formula; 3 new tests (335 pass)

- 2026-06-03 — docs(readme): reframe README for forkers — add identity/trust/truth blurb section, replace personal instance references with placeholders, forker-first voice throughout

- 2026-06-03 — feat(eval): Stage 2 of query-latency plan — `--runs N` (median-of-N latency + majority-vote correctness) and `--baseline` (append date/version/pass/p50/p95 to committed docs/eval-baselines.md); per-case + aggregate latency report. First baseline recorded. Surfaced behavioral-hard-tradeoff cites-source flake (#140)

- 2026-06-03 — feat(query): progressive disclosure for enumeration questions — `RULE_PROGRESSIVE_DISCLOSURE` leads with the 3 most-recent projects + names the total + offers the rest via a follow-up ("show more"); projects pre-sorted by `git_evidence.last_push_at` (then `started`). New `overview` eval category (17/17, 28/28). Measured: "all projects" answer 2,613→1,361 chars, llm ~10s→~7s, with quality held — and stays bounded as project count grows

- 2026-06-03 — feat(query): instrument phase timings — persist `llm_ms` + `retrieval_ms` to observed_queries; Stage 1 of the query-latency plan (docs/plans/query-latency.md). Initial assessment: "recent projects" query is ~90% LLM generation (output length), ~10% retrieval, ~0 framework overhead

- 2026-06-03 — docs(roadmap): rewrite ROADMAP.md — current through v0.4.42, Next and Exploring sections updated

- 2026-06-03 — docs(readme): link resume-agent-web companion repo; fix architecture diagram; correct homepage to agent.yuens.me; roadmap updated to current state

- 2026-06-02 — ci(sync): upgrade GitHub Actions runner to Node.js 24 (20 deprecated June 16)

- 2026-06-02 — ci(sync): pass EMPLOYMENT_SYNC_* and OEP signing vars to GitHub Actions — consolidation and git_evidence signing were silently skipped in nightly runs

- 2026-06-02 — refactor(observations): default to the authored "why" layer (observation/idea/task) and exclude the git-sync `reference` changelog ledger unless `?type=reference`; topic matching is now case-insensitive so casing variants resolve to one trail; type filter applied at the DB layer (before LIMIT) so the small authored corpus isn't crowded out by the freshly-synced ledger. Clarifies the split: `/observations` = authored why · `/verify` = proven what · `/query` grounds on both. Docs (README, openapi, .env.example) updated for self + downstream

- 2026-06-01 — feat(observations): public `GET /observations` + `/observations/:id` — browsable, individually-citable OB1 reasoning/premise trail (the "edge-resolver made browsable"); private thoughts excluded at the same boundary as `/query`, `404`-not-`403` on a private/unknown id; `OBSERVATIONS_TOPICS` scopes the default listing; advertised in openapi + agent-card; pure helpers unit-tested

- 2026-06-01 — feat(sync): employment consolidation — auto-apply delta proposals on configurable schedule with rubric gate; closes #129

- 2026-06-01 — fix(query): add premise-absent behavioral few-shot to RULE_OUTPUT_JSON — closes #126; eval 15/16 → 16/16 (25/25 rule points)

- 2026-06-01 — perf(query): 3 fixes — maxTokens 512 for conversational, skip thought embedding for binary questions, in-memory profile cache (5-min TTL); binary roundtrip overhead −18×, conversational behavioral LLM −42%; eval 15/16 unchanged

- 2026-06-01 — feat(oep): Phase 3 — sign git evidence with Ed25519 key; GET /verify/git-evidence; CLI verify-git-evidence.ts; README fork/identity clarity

- 2026-06-01 — chore: add MIT LICENSE file — closes #121

- 2026-05-31 — feat(oep): Phase 2a — git evidence per project via nightly sync; provider abstraction (GitHub implemented, GitLab/Bitbucket stubs); verification_status on profile; oep-verification.md documents full chain and peer attestation model

- 2026-05-30 — fix(query): follow_up_suggestions now written from visitor's perspective (third-person about the candidate, not second-person directed at them)

- 2026-05-30 — feat(sync): auto-infer status, url, and tech from GitHub repo metadata on each nightly sync run — closes #116

- 2026-05-30 — feat(query): add conversational mode (style: "conversational" / x-agent-type: human) — 2-4 sentence prose, no inline [N] markers, attribution via sources[] array only; feat(resume): expose jd_term_count in rubric response for thin-JD UX signalling

- 2026-05-29 — chore(seed): replace personal data with generic fork-starter template; real profile lives in Supabase

- 2026-05-29 — fix(data): rename artisan-roast project to "Artisan Roast Store" and trim description

- 2026-05-29 — docs(readme): fix stale QR badge, agent card version, missing routes (/health, /openapi.json, /qr, GET /), and setup step 10

- 2026-05-29 — feat(profile): add optional cover image URL to Project schema; populate 3 project covers from Supabase Storage

- 2026-05-29 — fix(qr): cast Buffer to Uint8Array for BodyInit compatibility — fixes Railway build failure

- 2026-05-29 — feat(routes): add GET /openapi.json (Custom GPT Actions schema) and GET /qr (QR code PNG targeting QR_TARGET_URL)

- 2026-05-29 — feat(data): add Brew Guide project to portfolio

- 2026-05-29 — feat(routes): GET / serves agent card directly; add GET /health → {status: ok}

- 2026-05-29 — fix(routes): serve /.well-known/agent-card as 200 JSON instead of 301 redirect — eliminates Google Safe Browsing false positive

- 2026-05-14 — feat(mcp): add `update_thought` + `delete_thought` to the private MCP — closes the CRUD loop on captured thoughts; previously the private MCP could capture, search, list, and aggregate, but had no way to edit a typo or remove a thought without dropping into SQL
  - `update_thought` takes an `id` plus optional `content` and/or `private`. When `content` changes, the embedding and metadata are regenerated so semantic search stays consistent with the new text. `source` and `private` are preserved from the existing row unless `private` is explicitly overridden — `undefined` means "leave unchanged", not "make public"
  - `delete_thought` takes an `id` and removes the row permanently (no soft-delete)
  - `search_thoughts` and `list_thoughts` now include each thought's row ID in their output so callers can target a thought for update/delete from chat
  - New pure helper `resolveThoughtUpdateOpts` in `src/lib/thought-metadata.ts` decides the next `source`/`private` to stamp on an edit; mirrors the capture-side privacy invariant in `buildThoughtMetadata` — privacy is always caller-controlled, never inferred from the existing row or from anything the model may have emitted
  - 7 new unit tests cover the merge invariants (preserve source, preserve private, respect explicit overrides including `false`, reject malformed existing metadata, treat non-`true` `private` values as public); `tests/thought-metadata.test.ts` is now 15/15
  - README + `docs/workflow.md` document both new tools and the ID-in-output behavior

- 2026-05-13 — docs(readme): add "Truth contract — we walk the talk" section — promotes the project's truth-and-verifiability ethos from a buried line in "Why this exists" to its own paired section opposite "What it is not". Four concrete commitments: (1) every factual claim is cited inline via footnote markers + `Sources:` block; (2) no fabrication — low confidence preferred over confident inference, with the rubric catching common failure modes (inference-padded declines, capability overclaim, false binary claims); (3) third-person factual narration, never impersonation; (4) verifiable via the owned spec + the runnable `npm run eval:query` harness — fork the repo and watch the agent honor each rule case-by-case. Closes with: "If a claim isn't cited, it isn't made. If the corpus is silent, the agent says so. If the agent breaks these rules, the eval catches it."

- 2026-05-13 — fix(query): few-shot examples + anti-fabrication tightening — second live-eval iteration after #100. (1) **Citation discipline**: added a "Few-shot examples" section to `RULE_OUTPUT_JSON` with five concrete full-JSON-response examples covering short binary (yes/no), short capability with adjacent layer, multi-citation behavioral, and a decline. Direct fix for the model partially adopting the citation rule on short answers — pattern-matching from concrete examples works where instructions alone didn't. (2) **Anti-fabrication**: rewrote `RULE_HONESTY` to call out the real failure mode — confident-sounding prose padding over a gap, not outright fabrication — and added an explicit "when uncertain between high-with-inference and low-with-named-gap, always pick low" rule to the confidence definitions. Added two new fabrication-bait eval cases (`no_data-led-large-team`, `no_data-managed-budget`) that ask behavioral questions with no direct corpus evidence; the agent now correctly produces factual declines instead of fabricating leadership/budget narratives from adjacent project work. Live eval: **1/14 → 14/16 cases passing, 24.0/26 rule points**. Categories: binary 2/2, capability 1/2, behavioral 3/3, off_topic 2/2, adversarial 2/3, no_data 4/4 (including both new traps). The remaining 2 failures are model variance (one cite-source drop, one JSON envelope drop) — same prompt produces correct output on adjacent cases. 225/225 unit tests

- 2026-05-13 — fix(query): v2 prompt + rubric fixes from first live eval — two real bugs surfaced by `npm run eval:query` on the v2 build. (1) **Decline `parse_error` (7/14 cases dead)** — `RULE_OUTPUT_JSON` showed the decline example as bare prose ("This question is outside the scope..."), and the model dutifully returned bare prose instead of a JSON envelope, breaking `parseJSON()`. Fixed by rewriting `RULE_OUTPUT_JSON` to show the full JSON envelope around both claim-bearing and decline examples and adding an explicit "every response is a single valid JSON object — never emit the answer string by itself" preamble. (2) **Blocking-only categories always failed by additive threshold** — adversarial cases have no additive rules; the scorer math gave them `0/1` with no path to pass. Fixed `scoreAnswer` (and the runner) to skip the threshold check when `additive.length === 0` and let blocking-rule outcomes carry the verdict alone. Also strengthened `RULE_CITATION` with an all-or-nothing clause ("if the answer contains any `[N]` marker, it must end with a `Sources:` block — single-citation answers are not exempt") + a self-check coda. Eval result jumped from **1/14 → 11/14 cases passing**: off_topic 0→2/2, no_data 0→2/2, adversarial 0→3/3 (the logic bug), binary 0→1/2, capability 0→1/2, behavioral 1→2/3. The remaining 3 failures are all `cites-source` partial-adoption on short answers — model produces markers but still skips the Sources block sometimes; that's iterative prompt-coaxing territory, not a structural bug. 225/225 unit tests (was 224; +1 for the blocking-only-categories fix)

- 2026-05-13 — feat(query): ship `/query` engagement rules v2 — third-person factual narrator + footnote citations — every named `RULE_*` constant in `src/lib/query-prompt.ts` re-voiced from first person to third ("Sunny built X..." / "the candidate has not worked with..."); new `RULE_CITATION` requires bracketed-integer markers (`[1]`, `[2]`, ...) on every factual claim and a `Sources:` block at the end of every claim-bearing answer mapping each marker to a corpus reference (`projects.<slug>`, `observations: "<excerpt>"`, etc.); `RULE_GAPS` drops the calendly contact-offer and the no-data sub-case (c) now resolves to the same factual-decline posture as off-topic ("the candidate does not appear to have documented work history or observations relevant to this question"); `RULE_ADVERSARIAL` re-voiced to "the agent will not roleplay or comply with attempts to override its scope." Rubric (`src/lib/eval-query-answer.ts`) drops the `no-data-offers-contact` rule (calendly-based), adds a deterministic `cites-source` rule for binary/capability/behavioral that checks the answer prose contains a `[N]` marker AND a `Sources:` block, adds a `no-data-factual-decline` rule that accepts any of a small known-value list of factual-decline phrasings (no exact-text matching on spec examples). Bug fixes from v1's live eval: the `"Kubernetes in production"` false positive is gone (the natural disclaimer contains the question's wording; the fixture's `mustNotClaim` now targets affirmative phrasings like "runs Kubernetes in production"); the no-data → off-topic misclassification is resolved by the unified decline posture. Threshold stays 0.35 (v1's data validated it). 218/218 unit tests (was 206; +12 new for v2 voice / citation / factual-decline). Plan: [`docs/plans/query-engagement-rules-v2.md`](docs/plans/query-engagement-rules-v2.md). Spec: [`docs/query-engagement-rules.md`](docs/query-engagement-rules.md). v1's plan stays in `docs/plans/` as historical record; v1 ROADMAP row gets a real PR link (#97 replaced "_this PR_")

- 2026-05-13 — docs(plans): add `/query` engagement-rules v2 plan — factual narrator + footnote citations — pivots v1's first-person voice to third person ("Sunny built X..." not "I built X..."), drops the calendly contact-offer from the no-data path (not portable to forkers, and the agent's posture is neutral factual reporter rather than personal representative), unifies no-data and off-topic responses around a single scope-decline posture, and adds `RULE_CITATION` requiring footnote-style markers (`[1]`, `[2]`) in the answer text with a `Sources:` block mapping each marker to a corpus reference (project slug / observation excerpt / employment-bullet path); folds in the two bugs surfaced by v1's live eval (the `"Kubernetes in production"` overclaim false-positive in the rubric fixture, and the no-data → off-topic misclassification — resolved by the spec unification); rubric drops `no-data-offers-contact` and adds a deterministic `cites-source` rule for binary/capability/behavioral; threshold stays 0.35 (v1's live data validated it); v1's plan stays in `docs/plans/` as historical record; ROADMAP "Next" reorders to lead with v2

- 2026-05-13 — feat(query): ship `/query` engagement rules + prompt-does-relevance + eval harness — `/query` and `/public-mcp ask_candidate` now answer per an owned spec ([`docs/query-engagement-rules.md`](docs/query-engagement-rules.md)) with first-person voice; off-topic redirect; direct gap handling (binary → yes/no, capability → name the gap + adjacent layer without overclaiming, no-data → say so + offer the calendly link); adversarial-input refusal; forbidden "on record" / "in the database" phrasing. Implementation: new `src/lib/query-prompt.ts` with named `RULE_*` constants composed by `buildSystemPrompt(callerHint, mode)`; the three inline string literals in `src/routes/query.ts` are gone; `buildQueryPrompt` adds a one-line "retrieved by similarity" preface under the observations heading so the system rule is reinforced at the injection point. Threshold reframe: `RULE_OBSERVATIONS_RELEVANCE` tells the model the injected thoughts may not all be relevant and to drop the irrelevant ones, so the cosine cutoff becomes a coarse pre-filter (env-overridable via `QUERY_THOUGHTS_THRESHOLD`, default 0.35) instead of the relevance gate. On-demand eval harness in `scripts/eval/run-eval.ts` (wired as `npm run eval:query`) runs ~14 fixture cases across six categories against a deterministic rubric (`src/lib/eval-query-answer.ts`, modeled on `score-resume.ts`) with an optional `--judge` LLM-as-judge pass; the no-data calendly check reads the runtime profile's `contact.calendly` (no hardcoded URL); flags `--case`, `--category`, `--threshold` for targeted runs and threshold sweeps. 51 new unit tests — suite at 176/176. README adds a "`/query` engagement rules & eval" section with quick-run examples; `docs/workflow.md` and `docs/README.md` link the spec

- 2026-05-13 — docs(plans): add `/query` engagement-rules plan — owned spec for voice (first person, always), off-topic redirect, direct gap-handling (binary experience → yes/no; capability → name the precise gap vs. adjacent layer, never overclaim; genuinely no data → say so + offer calendly), adversarial-input refusal; reframes the cosine similarity threshold as a coarse pre-filter (not the relevance gate) with the system prompt's new `RULE_OBSERVATIONS_RELEVANCE` doing fine-grained relevance judgment; adds a small on-demand eval harness modeled on `score-resume.ts` (hybrid deterministic + optional `--judge`) so prompt/threshold changes are evidence-based; explicitly tells the LLM that example phrasings are tone illustrations, not scripts, and the rubric never asserts on exact text; example phrasings purged of "on record" / "in the database" tells; ROADMAP "Next" reorders to lead with this plan

- 2026-05-12 — feat(mcp)/docs: add `private` flag to `capture_thought` and reconcile the doc chain — `capture_thought` (in this repo's `src/routes/mcp.ts`, not a separate OB1 repo as the thoughts-grounded-query plan wrongly assumed) now takes an optional `private: boolean`; when true it writes `metadata.private = true`, which `match_thoughts_public` already excludes from the public `/query` and `/public-mcp` surfaces; default unset = public-eligible. Privacy is caller-controlled, not model-controlled: the new pure `buildThoughtMetadata` helper strips any `source`/`private` keys the model-extracted metadata emitted and sets those flags solely from the explicit args — so a hallucinated or prompt-injected `"private": true` inside the thought text can't flip a thought's visibility (8 unit tests cover the invariant). Live round-trip verified the private thought is invisible to the public RPC and still visible to the private `match_thoughts` path. Doc-chain reconciliation: `docs/plans/thoughts-grounded-query.md` gets dated correction notes on decision #8 + impl-shape #4 (the param was never an external task) and decision #4 (the 0.55 threshold was tuned to 0.35 for the question path in #94); the stale "_this PR_" on the v0.4.7 ROADMAP row → #93; `docs/README.md` adds the now-shipped OEP Phase 1 and thoughts-grounded plans to the reference index; README + `docs/workflow.md` document the `private` param

- 2026-05-12 — fix(query): lower `queryRelevantThoughtsForQuestion` similarity threshold from 0.55 → 0.35 — the plan inherited 0.55 from the `/resume` JD path, but a short question embeds less richly than a full job description, so almost nothing crossed 0.55 and the feature returned zero grounding thoughts in practice; live calibration against the 1,913-thought corpus showed on-topic questions land at ~0.40–0.55 and clearly off-topic ones ("favorite color", "pineapple on pizza") at ~0.18–0.24, so 0.35 catches genuine matches with margin while still rejecting noise; verified: behavioral and technical questions now return 5 grounding thoughts, off-topic questions return 0; the JD-based `match_thoughts` path keeps 0.55

- 2026-05-12 — feat(query): ground `/query` and `/public-mcp` in OB1 project observations — natural-language answers now draw on a semantic search over the candidate's captured thoughts (judgment, tradeoffs, "why I built it this way", "when I stopped") layered above the structured `public_profile`, so behavioral and decision-making questions are answered from lived experience rather than inference over resume bullets; new `match_thoughts_public` SQL function returns the full non-private corpus and excludes thoughts flagged `metadata.private: true` via an index-friendly JSONB containment guard; new `queryRelevantThoughtsForQuestion` helper mirrors the existing `/resume` thoughts plumbing; `queryProfile`/`queryProfileStream` fetch profile + thoughts in parallel and inject the top matches under a `# Project observations and lived experience` heading; system prompt instructs the model to prefer observations for judgment questions; agent card `skills.query` description + examples updated and card bumped to 1.3.0; `/resume`'s `match_thoughts`-based injection is untouched; 9 new unit tests covering prompt shape and the migration's privacy guard; README documents the two-layer grounding and the `private` opt-out

- 2026-05-11 — fix(tests): pin system clock in `summarize-observed-queries.test.ts` to eliminate calendar drift — 12 of 25 tests had been silently failing since the wall clock passed `fixture_date + 7 days` (around 2026-05-04); fixtures use hard-coded dates `2026-04-25..28` and the aggregator's default window is `now - 7 days`, so once "now" moved past those dates the rows fell outside the window and counts went to zero; fix uses Node's `mock.timers.enable({ apis: ['Date'], now: ... })` in `before`/`after` hooks to pin "now" at `2026-04-29T00:00:00Z`; full unit suite is now 116/116 green (was 104/116)

- 2026-05-11 — docs(plans): add thoughts-grounded `/query` plan (planning only — implementation in a follow-up PR) — proposes semantically injecting OB1 project observations into the public `/query` and `/public-mcp ask_candidate` prompts so behavioral and judgment questions get answered from lived experience, not inferred patterns over employment bullets; proposes a default-public-with-`metadata.private`-opt-out policy backed by a same-day audit confirming 100% of 1,913 captured thoughts are public-eligible; specifies a sibling `match_thoughts_public` RPC to exclude private thoughts at the data layer while keeping the existing `/resume` thoughts-injection (via `match_thoughts`) untouched; ROADMAP "Next" reorders to lead with this plan; corrects stale "_this PR_" reference on the OEP Phase 1 shipped row to point at #90

- 2026-05-11 — feat(oep): ship Phase 1 domain verification — Ed25519 keypair generator (`scripts/generate-oep-keypair.ts`), public-key endpoint at `GET /.well-known/oep-public-key.json` returning `{alg, key, fingerprint, issued_at, version}` with `Cache-Control: public, max-age=300`, and CLI verifier (`scripts/verify-oep-domain.ts <domain>`) that asserts the DNS TXT `_oep.<root>` fingerprint, the endpoint's fingerprint, and a freshly recomputed SHA-256 of the raw key all agree; agent card exposes the same fingerprint at `provider.identity` (card bumped to 1.2.0); unconfigured key returns 503 without crashing the agent; 17 new unit tests covering the full pass/fail matrix; README "OEP domain verification" section walks the operator through generate → publish → verify

- 2026-05-11 — docs(plans): add OEP Phase 1 plan for DNS-TXT domain verification — narrow first-step plan toward the Open Employment Protocol; defines an Ed25519 key published at `/.well-known/oep-public-key.json` with its fingerprint mirrored in a DNS TXT record at `_oep.<root>`, plus a CLI verifier; ROADMAP "Next" promoted to lead with this plan, `a2a-trust-layer.md` repositioned as the broader exploration this unlocks

- 2026-05-11 — docs: align repo docs with the shipped public MCP stance
  - README — three access tiers (public HTTP, public MCP, private MCP) instead of two
  - ROADMAP — moves `/public-mcp` + `ask_candidate` from "In progress" to "Shipped" (v0.3.0, PR #66); "In progress" parked pending live traffic observations
  - docs/README — promotes the public-MCP plan to Shipped (reference); the plan stays in `plans/` as historical record per CONTRIBUTING convention
  - docs/plans/public-mcp-query-only.md — re-headered "Shipped" with pointers to live behavior in `workflow.md` and the README connector section

- 2026-05-02 — fix(resume): make injectProjectUrls reliable with slug requirement + name-normalized fallback — system prompt now explicitly requires `slug` verbatim from profile in project entries; `injectProjectUrls` falls back to normalized-name match when slug is absent, eliminating the no-op injection that caused missing project links

- 2026-05-02 — feat(ci): add nightly GitHub Actions sync workflow — replaces OS-specific task schedulers with a cross-platform cron that runs npm run sync on a configurable schedule (default 2am UTC daily); supports on-demand runs via workflow_dispatch from the GitHub UI or gh workflow run; GITHUB_TOKEN is automatic, only three secrets required (SUPA_PROJECT_URL, SUPA_SERVICE_ROLE, OPENROUTER_API_KEY); documents setup steps and cron examples in README

- 2026-05-02 — feat(sync): derive repos from profile.projects and add HIDE_FROM_PROJECTS filter — eliminates SYNC_REPOS env var (breaking); sync script now reads GitHub owner/repo from each project's repo URL so adding a project to the profile automatically includes it in the next sync; HIDE_FROM_PROJECTS env var (comma-separated slugs) filters projects from the resume output at generation time while keeping OB1 thoughts in play for employment context injection; documents both in a new "Project sync" README section

- 2026-05-02 — fix(resume): guarantee project url/repo in resume output — server-side injection matches generated projects to profile by slug and backfills url and repo fields that LLMs consistently omit; eliminates missing project links in DOCX regardless of model output

- 2026-05-02 — feat(resume): anchor experience bullets to OB1 pool — adds Rule 6 to the generation prompt with a show-don't-tell pattern (two JD-context examples) that instructs the model to select and lightly adapt from the candidate's canonical bullet pool rather than synthesizing from context; eliminates fabricated dates and non-canonical bullets; verified via parallel old/new prompt comparison and live pipeline run against a real JD (all 4 OB1 bullets present in output, lightly adapted, no invented metrics); adds scripts/compare-prompts.ts with --model mode for prompt vs model comparison

- 2026-05-02 — fix(scorer): drop Rule 5 (first bullet vs JD responsibility) — lexical keyword overlap is the wrong tool for a semantic question; boilerplate-detection heuristics were brittle and required constant patching; remaining 5 rules (title, keyword coverage, quantified bullets, authenticity, skills order) are fully deterministic and reliable

- 2026-05-01 — feat(resume): SSE keepalive streaming eliminates Railway 503 on long dual-model generations — POST /resume now returns a text/event-stream immediately, sends `: keepalive\n\n` every 10s, and emits the final resume JSON as a single `data:` event; bumps maxTokens to 8192 for Gemini 2.5 Flash thinking-token budget; strips banned phrases before scoring so Rule 4 reflects post-processed output; fixes Rule 1 adjective extraction ("talented Application Engineer" → "Application Engineer"); fixes Rule 5 to skip keyword overlap when JD opening is company boilerplate rather than stated duties

- 2026-05-01 — feat(sync): replace hardcoded REPOS array with SYNC_REPOS env var — forkers now configure repos in .env.local as comma-separated owner/repo pairs; slug is derived from the repo name; exits with a clear error on missing or malformed entries

- 2026-05-01 — fix(agent-card): add Cache-Control: public, max-age=300 to prevent indefinite caching by claude.ai and crawlers — no TTL caused claude.ai to serve a stale agent card after A2A spec fixes were deployed; 5-minute cap ensures changes propagate within one rotation while still allowing short-term caching to reduce Supabase round-trips

- 2026-05-01 — fix(agent-card): align agent-card.json with A2A v1.0 spec — adds required top-level fields `protocolVersion: "1.0"`, `url`, `securitySchemes: {}`, and `security: [{}]`; moves non-standard `supportedInterfaces` array from top level into `capabilities.extensions` to eliminate conformance checker failures

- 2026-05-01 — test(oauth): add e2e script proving token expiry, refresh, and rotation live — runs against a server with ACCESS_TOKEN_TTL=60; verifies access token is accepted then rejected after 65s (401 on /mcp + jwtVerify), refresh token exchanges for new access+refresh (rotation confirmed), new access token works immediately, old refresh token dead; all 8 steps passing

- 2026-05-01 — feat(oauth): persist refresh tokens in Supabase with rotation and reuse detection — eliminates reconnection prompts caused by in-memory token store being wiped on Railway restarts/redeploys; tokens are now stored as SHA-256 hashes in a new `oauth_refresh_tokens` table; each redemption atomically deletes the old row and issues a new token (rotation); replaying an already-used token triggers full revocation of all tokens for that client (reuse detection); 8 integration tests covering the full lifecycle including AC-8 reuse detection scenario

- 2026-04-30 — fix(mcp): add refresh_token grant to eliminate reconnection prompts — adds `refresh_token` to `grant_types_supported` OAuth metadata, implements RFC 6749 refresh_token grant in `/token`, issues refresh_token alongside access_token in authorization_code flow; tokens use configurable TTLs via `ACCESS_TOKEN_TTL` (default 1h) and `REFRESH_TOKEN_TTL` (default 30d) env vars; verified in production with claude.ai — automatic token refresh works without "reconnect required" prompts

- 2026-04-22 — docs: add mobile-setup caveat to README + workflow connector instructions — claude.ai custom connectors can only be *added* from desktop (web or Claude Desktop app), not the mobile app; once saved they sync automatically. Prevents recruiters from hitting a dead-end trying to add the connector from their phone.

- 2026-04-22 — feat(public-mcp): ship `/public-mcp` endpoint exposing a single unauthenticated tool (`ask_candidate`) that any MCP-aware AI client can add as a custom connector — wraps the existing `/query` handler via a shared `queryProfile` core, supports streaming via MCP progress notifications with client-echoed tokens, and logs every call (HTTP + MCP) to a new `observed_queries` Supabase table; advertised first in the agent card's `supportedInterfaces` (bumped to v1.1.0); 27 ACs defined with 24 automated tests passing, manually verified end-to-end via MCP Inspector including a progressToken routing bug surfaced + fixed during verification

- 2026-04-22 — chore: remove retired Supabase Edge Function artifacts and clarify Railway as the runtime tier — deletes `supabase/functions/open-brain-mcp/` and `supabase/functions/oauth-token/` (source preserved in git history), removes dead `ob1:deploy` / `ob1:logs` npm scripts and `SUPABASE_MCP_URL` env var, rewrites README architecture diagram to show Railway as the runtime host with Supabase scoped to data tier only; eliminates the recurring misread that conflates the retired Edge Function runtime with the active Postgres database

- 2026-04-23 — refactor(prompt): drop length + employment-trim rules from `/resume` system prompt — the shared service now generates a faithful resume from the full profile; downstream consumers (JHA, etc.) apply trim and length policy via `framing_hints`. The removed "Omit employment history that is irrelevant" instruction was dropping whole jobs with half a page of whitespace remaining; Rule 5 (PER-ROLE BULLET PRIORITIZATION) already handles relevance at bullet granularity, which is the right layer.
- 2026-04-22 — fix: add 301 redirect from /.well-known/agent-card to /.well-known/agent-card.json — eliminates 404 for clients hitting the extensionless A2A autodiscovery path
- 2026-04-22 — fix(mcp): bump SESSION_TTL_MS from 10 → 30 min and refresh lastUsed on every keepalive ping — sessions with an active SSE stream now stay alive indefinitely; dead sessions get a 30-minute grace window before eviction, eliminating mid-conversation "tool not found" drops on mobile
- 2026-04-22 — feat(mcp): replace stateful SSE transport with stateless Streamable HTTP — removes session map, GC, keepalive, and GET/DELETE endpoints; each POST is now a self-contained request (-83 lines). **Architectural post-mortem:** the stateful session model was built to solve Railway idle-timeout drops and job-hunt-agent pipeline continuity, but real-world usage on claude.ai mobile revealed a deeper mismatch — every new conversation required a manual MCP reconnect because session IDs don't survive across Claude conversation boundaries. The TTL and keepalive were band-aids on a model that was never the right fit: all 15 tools are stateless Supabase round-trips and none require server-side session continuity. The shift to stateless aligns the transport with how the tools actually work and how Claude clients actually connect.

- 2026-04-07 — feat(resume): implement dual-gen + rubric scorer pipeline achieving 5.82/6 ATS score — two independent LLM models compete per JD, deterministic 6-rule rubric (title mirroring, keyword coverage, quantified bullets, authenticity, bullet prioritization, skills ordering) picks winner, structured failure logging to OB1 for pattern analysis; 16 new unit tests, 34 total passing
- 2026-04-08 — fix(scorer): handle LLM returning skills as flat string[] instead of Skill[] objects — prevents runtime TypeError crash on Rules 2 and 6
- 2026-04-08 — fix(scorer): make Rule 4 (banned phrases) a hard veto scoring 0 — resumes containing "proven track record" or "leveraging" now lose to cleaner candidates instead of shipping with a penalty
- 2026-04-08 — feat(prompt): add Rules 7-8 — self-employment bullets reframed to match JD role (UX work for UX roles, not backend architecture); projects section reserved for technical highlights and scale
- 2026-04-08 — refactor(prompt): remove user-specific examples from system prompt — genericize Rule 3 example and Rule 7 to work for any OB1 profile, not just one candidate
- 2026-04-09 — feat(prompt): add separate-projects rule — treat each project as a distinct entry by goal and outcome, never merge regardless of shared tech stack
- 2026-04-09 — fix(resume): add banned-phrases post-filter — strips "proven track record", "leveraging", etc. from winning resume as safety net when both LLM candidates violate Rule 4; 10 new unit tests
- 2026-04-09 — feat(sync): extend OB1 enrichment pipeline — read feature docs + plan docs via GitHub Trees API, parse changelog into shipped vs unreleased sections, extract facts as attributed OB1 thoughts with content-hash dedup, propose employment bullet updates as review_needed thoughts; UX-aware highlights prompt replaces engineering-only bias; 10 new unit tests
- 2026-04-09 — feat(resume): thoughts-augmented generation — query OB1 for JD-relevant shipped facts at generation time, inject as attributed context between profile and JD; graceful fallback to [] on Supabase error

## [0.2.9] — 2026-04-06

- 2026-04-06 — fix(resume): pin contact block from profile in system prompt so LLM returns it verbatim instead of choosing which fields to include — fixes inconsistent contact info on generated resumes

## [0.2.8] — 2026-04-05

- 2026-04-05 — docs(sync): document npm run sync in workflow.md; add nightly bat script; fix NO_CHANGE false-positive for raw-markdown architecture values

## [0.2.7] — 2026-04-05

- 2026-04-05 — feat(sync): LLM-powered architecture + highlights reconciliation — strip markdown, semantic diff via claude-haiku-4.5, NO_CHANGE short-circuit to avoid unnecessary rewrites
- 2026-04-05 — fix(mcp): use timingSafeEqual for OPEN_BRAIN_KEY comparison in Edge Function fallback

## [0.2.6] — 2026-04-05

- 2026-04-05 — fix(sync): correct REPOS — artisan-roast → yuens1002/artisan-roast, add artisan-roast-platform as separate entry with platform.md

## [0.2.5] — 2026-04-05

- 2026-04-05 — feat(sync): support docsPath override per repo; artisan-roast-platform now syncs from docs/platform/platform.md instead of boilerplate README

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
