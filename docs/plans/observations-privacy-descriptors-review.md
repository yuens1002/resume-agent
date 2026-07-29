# /review report — observations authored signal · GET descriptors · telemetry privacy

**Branches:** `feat/observations-authored-signal` (#225) · `fix/get-descriptors-public-mcp-match` (#226) · `fix/private-telemetry-backfill` (#227)
**Generated:** 2026-07-29
**Iterations to reach verified:** #225 — 4 (initial → Copilot fixes → default flip → audit fix → revert to additive); #226 — 2; #227 — 2

## Structural exception — no in-repo plan

None of this work produced a plan with a deliverables table, so Step 0's role discovery uses the documented fallback: **de-facto owning roles**, named below, are the roles whose skill files `/retro` would edit if a lesson lands.

- `/backend-architect` — the `/observations`, `/match`, `/public-mcp` route surfaces
- `/test-engineer` — the three test files and the coverage gaps
- `/security` — the JD/job-application exposure and its backfill
- Cross-cutting → `/engineering-base` — the DRY findings below are duplication-audit misses, not role-specific

De-facto deliverables are taken from issues #222 and #223 plus the exposure found while probing #222.

## Verdict

**Minor.** No blocking issues; all three are safe for human review. The #225 revert is complete — zero orphaned machinery. Two tests pass vacuously by pinning a literal that lives in the producer instead of asserting the producer↔consumer relation, and one behaviour class (route-level envelope) has no automated coverage at all. None is load-bearing on a privacy invariant.

## Deliverables ↔ Code

| # | Deliverable (de-facto) | Implementation | Status |
|---|---|---|---|
| 222-1 | `authored` on every item | `src/lib/observations.ts:47,54,110` | ✓ shipped |
| 222-2 | Server-side `?authored=` filter | `src/lib/observations.ts:74`, `src/routes/observations.ts:70,144` | ✓ shipped |
| 222-3 | Additive — default unchanged | `parseAuthoredFilter` returns `undefined` when absent | ✓ shipped |
| 223-1 | `GET /match` descriptor | `src/routes/match.ts` | ✓ shipped |
| 223-2 | `GET /public-mcp` descriptor + 405 for SSE | `src/routes/public-mcp.ts` (`buildDescriptor`, `get('*')`) | ✓ shipped |
| P-1 | Rubric telemetry written private | `src/routes/resume.ts` `RUBRIC_FAILURE_METADATA` | ✓ shipped |
| P-2 | Historic rows un-published | `scripts/backfill-private-telemetry.ts` — 148 rows, executed | ✓ shipped + verified in prod |

### Code changes not tied to any deliverable

Three, all deliberate and each called out in #225's PR body rather than riding along silently:

| Change | Justification | Verdict |
|---|---|---|
| `?limit` ceiling 100 → 500 | Separately decided after the SPA clarification; free at the DB layer | ✓ justified, non-breaking |
| `total` / `truncated` envelope fields | Additive; `count` alone can't distinguish complete from capped | ✓ justified, non-breaking |
| `FETCH_CEILING` warn + corrected comment | The comment asserted a guarantee measured false (3,485 vs 1,000) | ✓ justified — see Docs drift |

**Scope-creep check on the revert:** clean. `resolveAuthoredFilter`, `DEFAULT_AUTHORED_FILTER`, the `AuthoredFilter` type, the `'all'`/`'any'`/`'both'` values, the always-echo, and the `src/routes/resume.ts` hunk are all gone. Verified by symbol scan — the only residual matches are `AuthoredFilter` as a substring of `parseAuthoredFilter`, `'any'`/`'both'` in `score-resume.ts`'s unrelated stopword list, and one CHANGELOG sentence explaining why the flip *wasn't* taken. No exported symbol in `src/lib/observations.ts` is unused outside its module.

## ACs ↔ Tests (Gate 3 spot-check)

| Behaviour | Test | Asserts invariant? | Notes |
|---|---|---|---|
| Allowlist excludes unknown machine sources | `observations.test.ts` — `isAuthoredThought` | ✓ | Covers `null`/`undefined`/non-string coercion and a hypothetical future source |
| Absent `?authored` ⇒ no filter | `observations.test.ts` — `parseAuthoredFilter: absent means NO filter` | ✓ | This is the assertion that makes the `?type=reference` regression impossible by construction |
| Rubric telemetry never public | `telemetry-privacy.test.ts` — `is private` | ✓ | Asserts through `isPublicThought`, the same predicate the public surface uses — the relation, not the literal |
| Frozen through nesting | `telemetry-privacy.test.ts` — `is frozen through the nested topics array` | ✓ | Asserts the `push()` actually throws |
| GET descriptors / 405 negotiation | `get-descriptors.test.ts` | ✓ | Status, `Allow` header, CORS, origin allowlist, and that GET doesn't shadow POST |
| **Descriptor advertises the real tool name** | `get-descriptors.test.ts:93` | **⚠ WEAK** | See F-1 |
| **Backfill selector matches the producer's topics** | `telemetry-privacy.test.ts:62` | **⚠ WEAK** | See F-2 |
| **Route envelope (`total`/`truncated`/filter)** | — | **⚠ MISSING** | See F-3 |

### F-1 — `ask_candidate` is three independent literals (#226)

`src/routes/public-mcp.ts` has the name at `registerTool('ask_candidate', …)` and again at `tools[0].name` and `example.params.name` inside `buildDescriptor`, with no shared constant. The test pins the literal:

```ts
assert.equal(tools[0].name, 'ask_candidate')
```

Rename the registered tool and the descriptor keeps advertising the old name — **the test stays green while the descriptor lies to exactly the agents the PR exists to serve.** The argument shape is duplicated the same way against the zod `inputSchema`.

The invariant is *"the descriptor names the tool this server actually registers."* Cheapest real assertion: the test already runs a live server, and `tools/list` is a POST that costs no model call —

```ts
const listed = await postJsonRpc('tools/list')
assert.equal(descriptor.tools[0].name, listed.result.tools[0].name)
```

Plus a shared `const PUBLIC_TOOL_NAME = 'ask_candidate'` so the two can't drift in the first place.

### F-2 — the backfill coupling is asserted only by comment (#227)

`tests/telemetry-privacy.test.ts:62` says in a comment that the backfill selects on `resume-failure` and a rename "would silently orphan future rows from that repair path" — then asserts a literal:

```ts
assert.deepEqual([...RUBRIC_FAILURE_METADATA.topics], ['resume-failure', 'rubric'])
```

`scripts/backfill-private-telemetry.ts:52` independently pins `topic: 'resume-failure'`. Rename the topic and update the test literal, and the script silently stops matching — the exact failure the comment warns about, unguarded. The invariant is *"the backfill's selector is one of the producer's topics."* Export `TARGETS` (or the topic constants) and assert membership.

Severity is low: the backfill is a one-off that has already run, and `private: true` is now set at the producer regardless.

### F-3 — no route-level coverage for the envelope

`total`, `truncated`, the `authored` echo, and the interaction of filter-before-limit are verified **only by live requests against production data**, recorded in the PR body. The pure helpers are well covered; the route is not, because it imports `supabase` directly and there's no fixture layer.

This is the highest-value finding, because it is the class of gap that actually bit: **498 unit tests were green while `?type=reference` returned 0 rows.** The bug lived entirely in route-level composition, which no test observes.

## Docs drift

| Location | Status |
|---|---|
| `README.md:281,289` — `/observations` filters | ✓ accurate post-revert; states default unchanged, `?authored=` (`1`/`0`), `?limit` 1–500 |
| `README.md:142` — thoughts data-tier row | ✓ accurate; names `metadata.source` split |
| `src/routes/observations.ts` note + doc comment | ✓ accurate; `?type=reference` promise holds again |
| `src/routes/openapi.ts:212,221,235` | ✓ accurate; `authored` param has no over-strict enum, response `type` is `nullable` |
| `src/routes/observations.ts:18-33` — `FETCH_CEILING` | ✓ **corrected** — previously claimed the ceiling sits above the largest type; measured 3,485 `reference` rows vs 1,000 |
| `docs/plans/public-mcp-query-only.md` AC-3 | ✓ updated in place with supersession note rather than silently rewritten |
| `CHANGELOG.md` | ✓ three entries, versions 0.4.97 / 0.4.98 / 0.4.99, no stale BREAKING marker after the revert |

**No stale claims found.** The `?type=reference` promise appears in four places and is true in all four.

## Open pre-existing issue surfaced (not introduced here)

`FETCH_CEILING = 1000` vs **3,485** `reference` rows. `?type=reference&topic=…` silently misses matches older than the window, on production, today. Independent of all three PRs — visible only because #225 added the warning. Deliberately out of scope; wants its own issue.

## Recommendations

1. **F-1** — extract `PUBLIC_TOOL_NAME` and assert the descriptor against a live `tools/list`. Small, and it closes a lying-descriptor path on the PR whose whole point is descriptor honesty.
2. **F-3** — decide whether route-level testing is worth a fixture layer. Not a #225 blocker, but it is the gap that let the `?type=reference` regression through a green suite.
3. **F-2** — couple the backfill selector to the producer constant, or accept and drop the misleading comment.
4. File the `FETCH_CEILING` paging issue.

None blocks human review.

## Inputs for /retro

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"When an endpoint composes several filters, a green unit suite over the pure helpers is not coverage of the endpoint. Before claiming a route is verified, enumerate its parameter combinations — including the ones the change doesn't touch — and check the ones a doc string promises. A documented escape hatch (`?type=reference`) is a contract; a change that empties it is a regression even when every helper test passes."*
  **Triggered by:** F-3 — 498 tests green while `?type=reference` returned 0.

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"When a test's own comment explains why two artifacts must agree, assert the agreement, not a literal copy of one side. `assert.deepEqual(X.topics, ['resume-failure'])` next to a comment about the backfill script is a change-detector, not a coupling test — import the other side and assert membership."*
  **Triggered by:** F-1, F-2 — both pin a literal the producer also owns.

- **Route:** `/engineering-base` → `~/.claude/commands/engineering-base.md` (duplication audit)
  **Draft principle:** *"An identifier that crosses a machine-readable boundary — a tool name in both a registration and its self-descriptor, a topic in both a writer and its repair script — is a DRY violation with a silent failure mode: the duplicate keeps serving a stale value while tests pin it. Extract the shared constant at the point the second copy is written, not at the third."*
  **Triggered by:** F-1 (`ask_candidate` ×3), F-2 (`resume-failure` ×2).

- **Route:** `/backend-architect` → `~/.claude/commands/backend-architect.md`
  **Draft principle:** *"Changing the default of a public endpoint is a breaking change even when the field is additive. Before flipping one, name the surface that is actually consumed — for a crawlable API that is usually the rendered page, not the JSON — and confirm the default change buys something the caller can't get by passing a parameter."*
  **Triggered by:** the authored-only flip, which cost a regression and three follow-on commits before being reverted to the original additive design.
