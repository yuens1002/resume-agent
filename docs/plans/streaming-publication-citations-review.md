# /review report — streaming publication citations (#251)

**Branch:** `fix/251-streaming-publication-citations` (PR #253)
**Reviewed SHA:** `715f4c4` (range `main..715f4c4`)
**Generated:** 2026-09-06
**Iterations to reach verified:** 1 (this review), after 1 external Copilot round

## Verdict

**Minor issues — human review can proceed once the three documentation findings below are applied.** No deliverable is missing, no test passes vacuously, and no code change is unbacked. All three findings are the same shape: prose written at the first commit that later commits invalidated and nobody reconciled. Nothing blocking; nothing in the runtime behavior is wrong.

### Structural exception — no in-repo plan

This feature shipped on the lean cadence (owner decision: ACs in the PR body, no `docs/plans/{feature}.md`), so Step 0's role discovery falls back to **de-facto owning roles** — the roles `/retro` would edit if this surfaced a lesson:

- `/backend-architect` — the stream transform, `queryProfileStream`'s contract change, response construction, the observability tee
- `/test-engineer` — `tests/publication-citations-stream.test.ts`

Deliverables are read from the approved plan at `~/.claude/plans/hi-claude-let-s-work-nested-liskov.md` (session-local, not in-repo).

## Deliverables ↔ Code

| Deliverable | Implementation | Docs touched? | Status |
|---|---|---|---|
| Streaming normalizer core + TransformStream adapter | `src/lib/publication-citations.ts:389-518` | Y | ✓ shipped |
| `queryProfileStream` returns normalized `{ textStream }` | `src/routes/query.ts:546-592` | Y | ✓ shipped |
| `handleQuery` response construction; tee preserved downstream | `src/routes/query.ts:643-690` | Y | ✓ shipped |
| public-MCP call site (second affected surface) | `src/routes/public-mcp.ts:129-152` | Y | ✓ shipped |
| Unit suite + `test:unit` registration | `tests/publication-citations-stream.test.ts`, `package.json:17` | — | ✓ shipped |
| Reference-doc correction | `docs/query-engagement-rules.md:121-125`, `README.md:342` | Y | ✓ shipped |
| CHANGELOG + version bump | `CHANGELOG.md:5`, `package.json:3` | Y | ⚠ stale — see F2 |

### Code changes not tied to any deliverable

- **`Cache-Control: no-store` on the streamed response** (`src/routes/query.ts:686-689`). Correct and now the two paths agree, but it is **scope the approved plan explicitly deferred** ("that's scope creep; mention as optional"). It entered on Copilot's review feedback and was accepted without re-checking it against the plan's stated scope. Recorded rather than reverted — it is a one-line consistency fix in code this PR already rewrites — but the plan→code map should show it as an addition, not pretend it was always in scope.

No other unbacked changes. `main..715f4c4` touches 9 files, all accounted for above.

## ACs ↔ Tests (Gate 3 spot-check)

ACs live in the PR #253 body. Sampled AC-1, AC-3, AC-5, AC-6, AC-10, AC-13.

| AC | Test file | Asserts invariant? | Notes |
|---|---|---|---|
| AC-1 | `publication-citations-stream.test.ts:88` | ✓ | Asserts against a **literal** normalized string, not just against `normalizePublicationSourceLines`. Deliberate: comparing the two paths to each other passes if both regress identically. |
| AC-3 | `:129` | ✓ | Property at every character boundary + per-character chunking. The strongest assertion in the suite. |
| AC-5 | `:165` | ✓ | Asserts `push()` **returns the chunk** — release timing, not just final bytes. Catches a pass-through regression that byte-equality would miss. |
| AC-6 | `:189` | ✓ | Same shape: body released before `flush()` is reached. |
| AC-10 | `:246` | ✓ | Every marker form `SOURCES_BLOCK_RE` accepts, split at every index — this is what pins the hand-written `PARTIAL_SOURCES_RE` to the regex it mirrors. |
| AC-13 | `:274` | ✓ | **Mutation-verified in both directions** — fails against `const scanFrom = emitted`, passes against the fix. |

**Mutation-check coverage (test-engineer: "a test that passes with the behaviour removed is not a test").** AC-13 was mutation-checked because it was written *after* a wrong first attempt: the original AC-13 asserted byte-equality and **passed against the broken implementation**, because `flush()` re-normalizes the full accumulated text and slices at `emitted`, so a false block start earlier than the true footer still lands in the untouched head. That is the finding of this review most worth carrying forward — see /retro inputs. AC-1 is mutation-safe by construction (a no-op normalizer fails its literal). AC-2/4/7/8/9/11/12 were not mutation-checked; they are corroborating rather than load-bearing.

**Suite status, stated precisely:** `npm run build` (tsc) clean; `npm run test:unit` 674 tests, 672 pass, 0 fail, **2 skipped — both expected and self-declaring** (`thoughts-grounded-query.test.ts:307,328`, skipped because `HIDE_FROM_PROJECTS` is set in the local `.env.local`; they run in CI). This is a unit + live-smoke pass, not a full-integration pass — `test:integration`, `test:public-mcp`, and the eval suites were not run as gates.

## Docs drift

### Stale claims (contradiction)

**F1 — `src/routes/query.ts:650` says the wire format is unchanged; it isn't.**

```
// { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
// — so the wire format is unchanged.
```

Commit `76855b9` then added `Cache-Control: no-store` to that same response, 35 lines below. The comment was accurate when written at `a014cef` and was never reconciled. This is the exact shape of `/backend-architect`'s existing retro principle about a rule restating its own requirement in several places — here applied to a code comment and the line it describes.

**F2 — `CHANGELOG.md:5` states facts that later commits in this same PR changed.**

- "27 new unit tests" — the suite is now **36** (AC-12 and AC-13 were added after the bullet was written).
- The bullet never mentions `Cache-Control: no-store`, which is a real behavior change shipping in this PR.
- It describes `toTextStreamResponse()` as "inlined as the two lines it is," which is no longer literally what the code does.

The CHANGELOG bullet was written at the first commit and treated as done. Per `CONTRIBUTING.md` it is one line per **PR**, not per commit — so it owes an accurate account of the merged whole.

### New-claim accuracy (overclaim)

**F3 — `docs/query-engagement-rules.md:123` overclaims byte-identity between the two paths.**

> "What a streamed caller sees in that footer is byte-identical to what a non-streamed caller sees in `answer`."

Not true, and not what was verified. The two paths build **different system prompts** (`buildSystemPrompt('stream', …)` vs `('json', …)`), so the model's raw output differs before any normalization runs; and the non-streaming path additionally applies `salvageTrailingSourcesBlock` and the #215 decline guard, neither of which exists on the stream. What is actually true — and what the tests prove — is that **the same normalization function is applied, so a publication citation takes the same documented form on both paths**. "Byte-identical" is a stronger word than the evidence supports.

### Missing updates (omission)

- `src/routes/openapi.ts` — **no update owed.** It documents only `question` and `context` on the request and the JSON response shape; `stream` and `style` have never been documented there (the schema is scoped for Custom GPT Actions, which do not stream). Internally consistent as-is.
- `ROADMAP.md` — **no update owed.** Its Shipped table stalls at v0.4.42 and #177 chunk 2 (v0.4.111) did not append either; following the live precedent rather than reviving a stale table for a bug fix.

### Implemented-plan spec scan (3d)

`docs/plans/publication-citations.md:114-118` and `publication-citations-review.md:90` both describe the streaming gap as open and "filed as #251." Correct as historical record — per `CONTRIBUTING.md` a plan "stays put" after shipping — and both name #251, so a reader lands on the resolution. **No edit owed.**

## Docs hygiene / public-voice audit

| Finding | Kind | Location | Introduced or pre-existing |
|---|---|---|---|
| None | — | — | — |

Test fixtures are invented (`example.test` URLs, `alpha-piece`/`beta-piece` slugs) and pin no live profile value — matching the convention `tests/publication-citations.test.ts` set. The real publication slug and `dev.to` URL appear only in the PR body's live-verification transcript; both are the candidate's own published work and already public. No absolute local paths, credentials, or PII in any touched file. No first-person/maintainer-workflow voice introduced.

## Observability note (not a defect, but a recorded consequence)

`logObservedQuery` now receives the **post**-normalization text on the streaming path. This was explicitly requested in #251 ("it should probably receive the normalized text so stored observations match what the client saw") and matches what the JSON path already does.

Consequence worth recording: **neither path preserves the model's pre-normalization citation form.** "How often does the model emit the raw `publications[0]`?" — the compliance signal that motivated #177 in the first place — is not answerable from `observed_queries` on either surface. Pre-existing on the JSON path; this PR extends it to a second one. Adjacent to `/backend-architect`'s retro principle that a per-surface transform must run *after* the shared observability write, though not a violation of it: this transform is not per-surface, and logging the pre-normalization text would break the parity the issue asked for. If citation compliance ever needs monitoring, it needs its own field, not a reordering of this tee.

## Recommendations

1. **Fix F1** — reword the `query.ts` comment so it describes the response as `toTextStreamResponse()` plus an added `no-store`, not as unchanged.
2. **Fix F2** — rewrite the CHANGELOG bullet to describe the merged PR: correct test count, the `no-store` addition, and the reverted out-of-scope commit.
3. **Fix F3** — replace "byte-identical" with the claim the tests actually support (same normalization, same documented form).
4. **No action** — `Cache-Control` scope addition, openapi, ROADMAP, plan docs: recorded above, all deliberate.

## Inputs for /retro

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"When a transform holds output back and releases it later, a byte-equality test does not prove the hold logic is correct — a final `flush()` that recomputes from full accumulated state will produce the right bytes even when the streaming decision that led there was wrong. For any buffering/streaming component, write at least one assertion on **when** output is released (what a single `push()` returns), not only on the concatenated result. Mutation-check that assertion specifically."*
  **Triggered by:** AC-13. The first version of it asserted byte-equality against a deliberately broken `scanFrom = emitted` and passed, because `flush()` masked the fault. Only an assertion on per-`push()` release timing caught it.

- **Route:** `/backend-architect` → `~/.claude/commands/backend-architect.md`
  **Draft principle:** *"A code comment that characterizes an adjacent construct ('this is what helper X does', 'the wire format is unchanged') is a claim about the code beside it, and any later commit that changes that code invalidates the comment. Before finishing a PR that landed in more than one commit, re-read every comment written in the earlier commits against the final diff — the review-feedback commit is exactly where these go stale, because the fix lands in the code and not in the prose that described it."*
  **Triggered by:** F1 — `a014cef`'s "the wire format is unchanged" survived `76855b9` adding a response header 35 lines away.

- **Route:** cross-cutting → workflow / `/commit` skill
  **Draft addition:** *"The CHANGELOG bullet is per-PR, not per-commit. When a PR grows commits after the bullet is written — review fixes, added tests, a revert — the bullet must be re-read against the final `main..HEAD` diff before merge. Counts ('N new tests'), named mechanisms, and 'no other behavior changed' statements are the ones that rot."*
  **Triggered by:** F2 — bullet claimed 27 tests (actual 36) and omitted a shipped behavior change.

- **Route:** cross-cutting → `/review` process itself
  **Draft addition:** *"Run `/review` before opening the PR, not after. In this feature it ran post-PR only because the human asked; two of the three findings an internal pass would have caught (the missing `no-store`, the quadratic rescan) were instead found by the external reviewer, costing a review round-trip and an out-of-scope commit pushed onto the branch."*
  **Triggered by:** the sequencing of this session — plan → implement → verify → PR, with no internal review step, and a lean-docs decision that was allowed to silently absorb the review *pass* as well as the review *doc*.
