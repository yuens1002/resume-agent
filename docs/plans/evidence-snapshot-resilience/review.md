# /review report — evidence-snapshot-resilience

**Branch:** `feat/evidence-snapshot-resilience` (first reviewed at `33e369d`; updated after the Copilot round, base `origin/main` = `d1a7379`, merge-base equal — base confirmed current)
**Generated:** 2026-09-19
**Iterations to reach verified:** 1 orca round + 1 OCR fix round + 1 Copilot round

## Verdict

**Minor issues, all resolved in this tree.** Every deliverable shipped with tests and all 17 ACs hold. The findings below were raised by this review and fixed in `a3b16ac`; a later round of Copilot review on PR #287 raised four more, fixed in the commit that follows it. Both rounds are recorded here with their resolution, so this report describes the submitted tree rather than a moment during it.

## Deliverables ↔ Code

| Deliverable | Implementation | Docs touched? | Status |
|-------------|----------------|----------------|--------|
| D1 retention migration | `supabase/migrations/20260919000000_application_evidence_snapshot_retention.sql` (`application_evidence_snapshot_retention`, `application_evidence_snapshot_prune_batch`, redefined `create_application_evidence_snapshot`) | Y | ✓ shipped |
| D2 retention tests | `tests/application-evidence-snapshot-retention.test.ts` (7 cases), registered in `test:application-evidence-source` | Y | ✓ shipped |
| D3 source-contract doc | `docs/application-evidence-snapshot.md` — new Retention section | Y | ✓ shipped |
| D4 bounded fetch | `src/lib/bounded-fetch.ts` (`SUPABASE_FETCH_TIMEOUT_MS`, `createBoundedFetch`), wired in `src/lib/supabase.ts`; `src/lib/profile-cache.ts` keeps its own tighter bound, decision recorded in comment | Y | ✓ shipped |
| D5 single-flight cleanup | `src/lib/oauth-token-cleanup.ts` (`startOAuthTokenCleanup`, `OAUTH_TOKEN_PRUNE_INTERVAL_MS`, `OAUTH_TOKEN_FIRST_PRUNE_DELAY_MS`), wired in `src/routes/oauth.ts` | Y | ✓ shipped |
| D6 resilience tests | `tests/supabase-fetch-timeout.test.ts`, `tests/oauth-token-cleanup.test.ts`, registered in `test:unit` | Y | ✓ shipped |

### Code changes not tied to any deliverable

All three came from the OCR review round and are justified, but none is named in the plan:

1. `package.json` `engines.node` `>=20` → `>=20.3`, and the matching `CONTRIBUTING.md` line — `AbortSignal.any` (D4) does not exist before 20.3, so the declared floor was wrong.
2. `scripts/verify-job-feed-postgres.mjs` — its hard-coded migration list stopped at the superseded creator, so the isolated real-Postgres runner was exercising a definition production will not have.
3. `tests/application-evidence-snapshot.test.ts` — applies the retention migration, so the pre-existing suite runs against the current creator definition.

## ACs ↔ Tests (Gate 3 spot-check)

| AC | Test file | Asserts invariant? | Notes |
|----|-----------|---------------------|-------|
| AC-FN-1 (pruning, batched) | `application-evidence-snapshot-retention.test.ts` | ✓ | Ages rows relative to the retention function, never to a literal; the batch case fails if the `limit` is removed (verified by mutation) |
| AC-FN-4 (pruned ID refuses) | same | ✓ | Asserts P0001 at the RPC and `snapshot_not_found` through the real MCP adapter |
| AC-FN-5 (defined once) | same | ✓ | Asserts the creator carries no interval literal and calls the function by name |
| AC-FN-9/10 (single-flight) | `oauth-token-cleanup.test.ts` | ✓ | Counts prune calls across many mocked intervals; now raced against a real-time deadline so a regressed guard fails instead of hanging |
| AC-FN-7/8 (bounded fetch) | `supabase-fetch-timeout.test.ts` | ✓ | Drives the real shared client against a socket that never replies; asserts caller signals are combined, not replaced |
| AC-TST-1 / AC-TST-2 | `package.json` scripts | ✓ | Both suites run: 44 evidence, 767 unit |

No weak or missing tests found. The external OCR bundle independently mutation-tested these files and every mutation was caught.

## Docs drift

### Stale claims (contradiction) — all fixed in `a3b16ac`

1. **`plan.md`, §2 third decision** (fixed) — states the one-time `VACUUM FULL` "is a post-merge operation (§5)". It was actually performed on 2026-09-19 at 15:18Z, before merge, as an owner-approved manual cleanup (307 MB → 83 MB; database 406 MB → 182 MB). The plan should record what happened rather than what was intended.
2. **`plan.md`, §5 row O2** (fixed) — "One snapshot call triggers the first prune" is no longer true: the prune is bounded per call by `application_evidence_snapshot_prune_batch()`, so a backlog drains over several calls.
3. **`plan.md`, Deliverables row D1** (fixed) — describes the prune without the per-call bound that shipped.

No stale claims found outside the plan: `README.md`'s MCP tool list and `docs/application-evidence-snapshot.md` both match the shipped behavior, and no doc claimed anything about the old cleanup cadence or the absence of a fetch timeout.

### Missing updates (omission)

1. **`CHANGELOG.md`** (fixed) — `CONTRIBUTING.md` requires one line per PR under `## [Unreleased]` plus a `package.json` version bump. The entry was added in `a3b16ac`; the bump to `0.4.130` followed in the Copilot round, which is where its absence was caught.
2. No other enumeration needs this feature: the retention behavior belongs to the existing source contract (updated), and the new constants are code-level, not environment variables, so the env-var documentation is unaffected.

### Internal consistency (doc ↔ doc, doc ↔ itself)

Run over every file the branch touched, re-run **after** the Copilot fix round (the pass that matters is the one after the last fix, not before the first).

- **Anchors:** `plan.md`'s `§5`/`§2` references and all `D1`–`D6` IDs resolve; ACs Plan-refs all match deliverable IDs (Gate 1 green).
- **Deictics:** none of the touched docs use "above/below/following" for a referent this branch moved.
- **Counts:** the ACs doc's 17 rows match the 17 verdicts recorded; the QC cells' test counts were updated to the current run (44 evidence-source, 767 unit) when the Copilot round added two tests.
- **Retraction propagation:** two retractions. The unbounded prune: grep for "each snapshot whose creation time is older" returns nothing outside the corrected text, and the plan, the source contract and AC-FN-1 all now state the bound. The never-empty-page claim: the source contract now explains why it holds (a `stable` reader) rather than asserting it flatly, and no sibling doc restates it.
- **Same-document contradiction:** none found.

## Docs hygiene / public-voice audit

| Finding | Kind | Location | Introduced or pre-existing |
|---------|------|----------|------------------------------|
| None introduced | — | — | — |

The branch diff was grepped for private repo/org/agent names and operational hosts: no hits. One earlier slip (an AC evidence cell that quoted the forbidden-name list itself) was caught and removed before review; the live branch and the published issue comments were re-read from GitHub to confirm. Pre-existing references to the sibling automation repo in `README.md` and `docs/appendix/` predate this branch and are unchanged.

## External review round (PR #287, Copilot)

Four findings, all fixed:

1. **No route-level proof of the timeout.** The suite proved the wrapper aborts, not that `/token` answers. A regression in the handler's error mapping could have left it hanging while every test stayed green. `tests/supabase-fetch-timeout.test.ts` now drives `POST /token` against a stub that accepts and never answers (and honours abort, as the platform fetch does), asserting a 5xx well inside the bound. `SUPABASE_FETCH_TIMEOUT_MS` is now readable from the environment and resolved per call, so a test can impose a short ceiling without waiting out the production one.
2. **The empty-page race was documented as impossible.** It was not: `get_application_evidence_snapshot_page` was `volatile`, so its two lookups took separate snapshots and a prune committing between them could return metadata with an empty page. The migration now re-declares the reader `stable` — body unchanged — which closes it, and a test pins the volatility.
3. **This report was stale** against its own tree. Rewritten as above.
4. **Version bump missing** beside the CHANGELOG entry, per `CONTRIBUTING.md`. Done.

## Remaining, deliberately open

Low-severity OCR findings, recorded rather than fixed: the route-level auth-code sweep body is covered by code review only (the module-level cadence is tested), and three test-quality nits (a vacuous timing bound, a shared PGlite fixture duplicated across two suites, env values not restored by the route-wiring test).

## Inputs for /retro

- **Route:** `/backend-architect` → `~/.claude/commands/backend-architect.md`
  **Draft principle:** *"A maintenance step added inside a request-path transaction must be bounded per call. An unbounded `delete … where <expired>` is fine in steady state and pathological on first run against a backlog: one client abort rolls back the whole transaction, and the next call repeats the same work, so the backlog never drains. Bound it, order it, and let it converge over several calls."*
  **Triggered by:** OCR medium on the retention prune; the branch's own 30 s client ceiling was the abort source that made it reachable.

- **Route:** `/backend-architect` → `~/.claude/commands/backend-architect.md`
  **Draft principle:** *"When introducing a runtime API that is newer than the declared engine floor (`AbortSignal.any`, `structuredClone`, `Array.prototype.at`), raise `engines` and the contributor docs in the same change. A deploy target that happens to run a newer patch release hides the mismatch until someone builds on the declared floor."*
  **Triggered by:** OCR low — `engines.node` said `>=20`, the code needs 20.3.

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"An assertion about a call that must not stay open may not itself be able to hang. Race it against a deadline that runs on real time — captured before any mock clock is installed, since mock timers swallow the guard's own timer — so a regressed guard fails with a diagnosis instead of stalling a suite that has no per-test timeout."*
  **Triggered by:** OCR medium — `runPrune while a prune is pending` hung for the full run when the guard was mutated away; the first fix attempt used the mocked `setTimeout` and did not fire.

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"When a repo keeps a hand-maintained migration list for an isolated real-database runner, adding a migration means adding it there too. Otherwise the runner silently verifies a superseded definition while reading as full coverage."*
  **Triggered by:** OCR low on `scripts/verify-job-feed-postgres.mjs`.

- **Route:** cross-cutting → `~/.claude/commands/review.md` (Step 3.5) and `.claude/oss-hygiene-rules.json`
  **Draft addition:** *"Evidence text that reports a hygiene check is itself public text: summarize the forbidden-name list ('the Public-Repo Rule's list'), never quote it. A passing hygiene verdict that enumerates the terms it searched for is the leak."*
  **Triggered by:** the AC-PUB-1 evidence cell that had to be amended and force-pushed off the public branch.
