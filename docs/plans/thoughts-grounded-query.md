# Plan: Thoughts-Grounded `/query` and Public MCP `ask_candidate`

**Branch:** `feat/thoughts-grounded-query` (not started)
**Status:** Planning — ready for review
**Scope:** Make `/query` and `/public-mcp` semantically inject OB1 thoughts (project observations, judgment, "aha" moments) as grounded context above the structured profile. Behavioral and decision-making questions get answered from lived experience, not from inferred patterns over employment bullets. Includes a default-public-with-`private`-opt-out policy on captures.

---

## Context

Today `/query` and `/public-mcp ask_candidate` answer questions using **only** `public_profile` — skills, employment bullets, projects, availability. The system prompt explicitly instructs the model to "answer using the structured data provided." That surface captures *snapshot* facts but not the candidate's *judgment*: why Prisma over raw SQL, what broke and what'd be done differently, how features are prioritized, when to stop. The behavioral and decision-making questions a recruiter or peer would ask — exactly the high-signal ones — have no grounded answer path.

`/resume` already proves the pattern: `queryRelevantThoughts(jd)` in `src/lib/thoughts-query.ts` embeds the JD, semantic-searches `thoughts` via the `match_thoughts` RPC, and injects top-8 attributed "shipped enrichment" thoughts into the prompt. The plumbing is there for resume generation; just not wired into `/query`.

This plan ports the pattern to `/query` (and therefore `/public-mcp`, since `ask_candidate` wraps `queryProfile`), with two key adaptations:

1. **Embed the question, not a JD.** Semantic search runs against the user's natural-language question.
2. **Default-public policy.** A 5/11/2026 audit of 1,913 thoughts found 100% are public-eligible (the single tax-prep outlier was deleted). Going forward, captures default to public; the rare exception sets `metadata.private: true` and is excluded from the public surface. No tier system, no review queue, no opt-in.

The vision line this implements, from Sunny's 5/6/2026 OB1 entry: *"Surface OB1 to agent as context — not just 'built Next.js app' but why Prisma over raw SQL, what broke, what I'd do differently. Judgment over syntax. Trajectory over snapshot. This is the soul of the agent."*

---

## Goals

1. New SQL function `match_thoughts_public` — semantic search over `thoughts` excluding any with `metadata.private = true`.
2. New helper `queryRelevantThoughtsForQuestion(question)` in `src/lib/thoughts-query.ts` — embeds the question, calls the public RPC, returns the top-N attributed contents. Same shape and graceful-degradation behavior as the existing JD-based helper.
3. `queryProfile` / `queryProfileStream` in `src/routes/query.ts` inject these thoughts as a labeled `# Project observations and lived experience` block above the profile data, with a single new line in the system prompt instructing the agent to prefer them for behavioral / judgment / decision-making questions.
4. `capture_thought` MCP tool gains an optional `private: boolean` parameter (default false). When `true`, persisted as `metadata.private = true`.
5. Agent card `skills.query.description` updated to mention "grounded in project observations and lived experience, not just resume bullets."
6. Backfill: every existing thought is treated as `private = false` implicitly (no `metadata.private` field). The new RPC's filter is `coalesce((metadata->>'private')::boolean, false) = false`, so absence-of-flag → public.

## Non-goals

- Surfacing `thoughts` raw through a new endpoint or tool. They remain accessible only as injected context inside `/query` and `/public-mcp` responses, never as their own return shape.
- Per-thought visibility tiers (public/internal/private). Boolean only. If a tier system is ever needed, the schema is open enough to grow it without breaking this work.
- Retroactive tagging tooling (UI, MCP tool to flip a flag, batch reclassifier). Default-public after the one-time audit means there's nothing to retag. Future captures can be tagged at capture time or with a one-off SQL update.
- Per-question retrieval tuning (cross-encoders, hybrid keyword + semantic, reranking). Top-N by cosine similarity is the proven shape from `/resume`; iterate only if observed behavior demands it.
- Caching the thought search. Embedding cost is negligible per question, and freshness matters more than cost.
- Changes to OB1 capture pipelines outside this repo (Claude.ai capture, dotfiles, etc.). The MCP tool gains the optional param; how callers expose it is their choice.

---

## Architecture

```
                                  POST /query  or  /public-mcp ask_candidate
                                            │
                                            ▼
                                     queryProfile(question)
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              ▼                             ▼                             ▼
   embed(question, 3-small)        SELECT * from              (existing)
              │                    public_profile             agent context
              ▼                             │                  / caller hint
   rpc('match_thoughts_public',             │                       │
       {query_embedding, threshold,         │                       │
        match_count})                       │                       │
              │                             │                       │
              │  (filters out               │                       │
              │   metadata.private=true)    │                       │
              ▼                             ▼                       ▼
        top-8 contents          ┌────────── prompt ───────────┐
                                │ # Project observations and  │
                                │   lived experience          │
                                │ - <thought 1>               │
                                │ - <thought 2>               │
                                │   ...                       │
                                │                             │
                                │ # Profile data              │
                                │ <public_profile JSON>       │
                                │                             │
                                │ # Question                  │
                                │ <user question>             │
                                └─────────────────────────────┘
                                            │
                                            ▼
                                    Claude (Haiku via OpenRouter)
                                            │
                                            ▼
                              QueryResponse { answer, confidence,
                                              sources, follow_up_suggestions,
                                              contact, meta }
```

### Privacy enforcement points

| Layer | Mechanism |
|---|---|
| Capture | `capture_thought` accepts optional `private: boolean`; persists `metadata.private = true` when set |
| Storage | `thoughts.metadata` is JSONB; existing GIN index covers the filter |
| Retrieval | `match_thoughts_public` RPC adds `coalesce((metadata->>'private')::boolean, false) = false` to the WHERE clause |
| Application | `/query` and `/public-mcp` only ever call `match_thoughts_public`; the existing `match_thoughts` stays in place for `/resume` (which already filters by `status: shipped`) |

A thought flagged `private` is invisible to the public surface end-to-end. The private MCP (Claude Desktop / claude.ai connector) still sees everything — it's the candidate's own brain, after all.

---

## Implementation shape

1. **`supabase/migrations/<ts>_match_thoughts_public.sql`** — new RPC function. Same signature as `match_thoughts` (`query_embedding`, `match_threshold`, `match_count`, `filter`) but adds a privacy guard. No changes to the `thoughts` table itself. Additive.

   ```sql
   create or replace function match_thoughts_public(
     query_embedding extensions.vector(1536),
     match_threshold float default 0.55,
     match_count int default 8,
     filter jsonb default '{}'::jsonb
   ) returns table (id uuid, content text, metadata jsonb, similarity float, created_at timestamptz)
   language plpgsql as $$
   begin
     return query
     select t.id, t.content, t.metadata,
            1 - (t.embedding <=> query_embedding) as similarity,
            t.created_at
     from thoughts t
     where 1 - (t.embedding <=> query_embedding) > match_threshold
       and (filter = '{}'::jsonb or t.metadata @> filter)
       and coalesce((t.metadata->>'private')::boolean, false) = false
     order by t.embedding <=> query_embedding
     limit match_count;
   end;
   $$;
   ```

2. **`src/lib/thoughts-query.ts`** — add `queryRelevantThoughtsForQuestion(question, limit = 8)`. Mirror the existing JD function: embed via `openai/text-embedding-3-small`, call `match_thoughts_public` RPC, return `string[]` of contents. On any error, return `[]` so `/query` never breaks because of thoughts unavailability.

3. **`src/routes/query.ts`** — call the new helper in both `queryProfile` and `queryProfileStream`. Inject the top-N as a labeled markdown block above the existing profile data in the prompt. One new line in both system prompts: *"When 'Project observations and lived experience' is provided below, prefer it for behavioral, decision-making, or judgment questions — those reflect the candidate's lived experience and are higher-signal than inference over resume bullets."*

4. **Open Brain `capture_thought` tool** (in OB1 — out of this repo). Add optional `private: boolean` parameter; when true, set `metadata.private = true` on the row. Document in the README's private MCP section. *This is the one change that lives outside resume-agent.* If OB1 isn't updated in the same window, captures default-public continues to work; only the future `-private` flag is unavailable until OB1 ships it.

5. **`src/routes/agent-card.ts`** — update `skills.query.description` to add the "grounded in project observations and lived experience" phrasing. Bump card version.

6. **`tests/thoughts-grounded-query.test.ts`** — new unit tests covering:
   - `queryRelevantThoughtsForQuestion` returns top-N contents on the happy path (against a stubbed Supabase client)
   - Returns `[]` on RPC error (no throw)
   - Returns `[]` on embedding error (no throw)
   - Privacy filter: an injected fixture thought with `metadata.private = true` is absent from the result
   - Prompt injection: when thoughts are present, the prompt contains the labeled block above the profile data
   - Prompt injection: when thoughts are absent (empty array), the prompt contains no block — same behavior as today

7. **README — Workflow section** — one short paragraph explaining that public `/query` answers are grounded in two layers: the structured profile (snapshot of skills/experience) **and** OB1 project observations (judgment, tradeoffs, lessons). One line on the `-private` opt-out for future captures.

---

## Decisions locked from planning session

1. **Default-public policy.** Of 1,913 captured thoughts on 5/11/2026, 100% were public-eligible (the 1 tax-prep outlier was deleted). The asymmetry matches reality: public is the common case, private is the rare exception. No tier system, no review queue, no opt-in.

2. **`metadata.private: boolean` (not a top-level column).** The `thoughts` table already has a JSONB `metadata` column with a GIN index. Storing `private` there is additive, requires no schema migration on the table, and stays consistent with how `type`, `topics`, `status`, etc. are already stored.

3. **New `match_thoughts_public` RPC (not modifying `match_thoughts`).** The existing function is used by `/resume`; leaving it alone means resume generation is unaffected. The new function is a sibling, ~5 lines longer, with the privacy guard baked in.

4. **Top-N = 8, threshold = 0.55.** Same parameters as `queryRelevantThoughts(jd)`. Proven values; no need to invent new ones for the first ship. Can tune later if observed behavior demands it.

5. **No `status`/`source` filter on the public query.** Unlike `/resume`, which filters to `status: shipped` + `source: enrichment` (resume needs concrete shipped facts), the public query searches the full non-private corpus. Behavioral questions ("how do you decide what to build?") are answered by observations, ideas, even task-type thoughts — not just shipped enrichment facts.

6. **Single labeled block in the prompt, not per-thought formatting.** A `# Project observations and lived experience` heading with a bulleted list of contents. Keeps the prompt structure obvious to the model; avoids inventing a citation format the response doesn't need yet.

7. **Graceful degradation.** Any failure in the thoughts retrieval path (embedding error, RPC error, empty result) returns `[]` — `/query` continues with profile-only context. No new failure modes added to the response surface.

8. **Capture-time `private` parameter lives in OB1, not resume-agent.** The MCP tool definition is in the OB1 repo. This plan describes the contract; OB1 ships the implementation. The two PRs can land independently — resume-agent's `match_thoughts_public` already honors any thought with `metadata.private = true` regardless of how it got set.

---

## Acceptance criteria

**Data layer**
- AC-1: `match_thoughts_public` SQL function exists and is callable from the service role. *(automated — integration test calls it)*
- AC-2: `match_thoughts_public` excludes any thought where `metadata.private` is the JSON boolean `true`. *(automated — fixture-based test)*
- AC-3: `match_thoughts_public` includes thoughts where `metadata.private` is absent, `false`, or `null`. *(automated)*

**Library**
- AC-4: `queryRelevantThoughtsForQuestion(question)` returns top-N contents from `match_thoughts_public` on the happy path. *(automated)*
- AC-5: Returns `[]` on embedding failure, RPC failure, or any thrown exception — never throws. *(automated)*

**Route behavior**
- AC-6: `POST /query` with a behavioral-style question (e.g. "how do you decide what features to build?") injects ≥1 thought into the prompt when relevant matches exist; injection block is labeled `# Project observations and lived experience` above the profile data. *(automated — prompt-shape test, golden file)*
- AC-7: When `queryRelevantThoughtsForQuestion` returns `[]`, the prompt contains no observations block and structure is unchanged from today's behavior. *(automated)*
- AC-8: `/public-mcp` `ask_candidate` tool produces the same thoughts-grounded response shape as `POST /query` (because both go through `queryProfile`). *(automated — public-MCP integration test extended)*

**Privacy enforcement (end-to-end)**
- AC-9: A test fixture inserts a thought with `metadata.private = true` whose content closely matches the test question's embedding; the content does NOT appear in the `/query` response or in the model's prompt. *(automated — assertion against the rendered prompt and the response)*
- AC-10: The existing `/resume` endpoint's thoughts injection (via `match_thoughts` filtered by `status: shipped`) is unchanged — no regression in resume generation tests. *(automated — existing resume tests must continue to pass)*

**Surface / discovery**
- AC-11: Agent card `skills.query.description` mentions project observations / lived experience; card `version` bumped. *(automated — agent-card test asserts substring + version bump)*
- AC-12: README has a short Workflow paragraph explaining the two-layer grounding (profile + observations) and the `-private` opt-out. *(manual — visual check)*

---

## Rollback

Single revert: `git revert <merge-sha>` removes the new helper, the prompt-injection call site, the agent card change, and the tests. The `match_thoughts_public` SQL function stays in place (harmless and unused); it can be dropped at leisure with `drop function match_thoughts_public(...);` if desired, but doing so is not required for the rollback to be safe. Any `metadata.private` flags set on thoughts during the live window stay set — they remain invisible to `/query` simply because `/query` is back to its pre-feature state of not querying thoughts at all.

---

## What this unlocks

- **Behavioral interview answers grounded in real experience.** "How do you decide what features to build?" / "When did you stop iterating and ship?" / "What's a tradeoff you'd revisit?" — all of these have signal in OB1 thoughts that the profile cannot express. After this, the agent can reach for it.
- **Case-study mode.** A future enhancement could let `/query` synthesize across multiple project observations to answer "walk me through the hardest engineering decision you've made" — same data path, richer prompt.
- **Invocation receipts referencing source thoughts.** Phase 3 of the OEP roadmap (signed receipts) becomes more valuable when the response can attribute back to specific thought IDs — provable grounding, not just plausible prose.
- **The "soul of the agent."** This is the line Sunny named in the OEP vision (5/6/2026 OB1 entry): *judgment over syntax, trajectory over snapshot*. Phase 1 of OEP proved domain ownership; this proves *grounding in lived experience*, which is the other half of "your agent is your truth."
