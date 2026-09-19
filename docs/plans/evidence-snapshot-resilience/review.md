# /review report — evidence-snapshot-resilience

**Branch:** `feat/evidence-snapshot-resilience` (reviewed at `33e369d`, base `origin/main` = `d1a7379`, merge-base equal — base confirmed current)
**Generated:** 2026-09-19
**Iterations to reach verified:** 1 orca round + 1 OCR fix round

## Verdict

**Minor issues.** Every deliverable shipped with tests, and all 17 ACs hold after the fix round. Three doc items need updating before human review: the plan's own post-merge section now describes a prune that no longer behaves that way and an operation that has already been performed, and the repo's CHANGELOG convention has not been satisfied yet. No code changes required.

## Deliverables ↔ Code

| Deliverable | Implementation | Docs touched? | Status |
|-------------|----------------|----------------|--------|
| D1 retention migration | `supabase/migrations/20260919000000_application_evidence_snapshot_retention.sql` (`application_evidence_snapshot_retention`, `application_evidence_snapshot_prune_batch`, redefined `create_application_evidence_snapshot`) | Y | ✓ shipped |
| D2 retention tests | `tests/application-evidence-snapshot-retention.test.ts` (6 cases), registered in `test:application-evidence-source` | Y | ✓ shipped |
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
| AC-TST-1 / AC-TST-2 | `package.json` scripts | ✓ | Both suites run: 43 evidence, 766 unit |

No weak or missing tests found. The external OCR bundle independently mutation-tested these files and every mutation was caught.

## Docs drift

### Stale claims (contradiction)

1. **`plan.md`, §2 third decision** — states the one-time `VACUUM FULL` "is a post-merge operation (§5)". It was actually performed on 2026-09-19 at 15:18Z, before merge, as an owner-approved manual cleanup (307 MB → 83 MB; database 406 MB → 182 MB). The plan should record what happened rather than what was intended.
2. **`plan.md`, §5 row O2** — "One snapshot call triggers the first prune" is no longer true: the prune is bounded per call by `application_evidence_snapshot_prune_batch()`, so a backlog drains over several calls.
3. **`plan.md`, Deliverables row D1** — describes the prune without the per-call bound that shipped.

No stale claims found outside the plan: `README.md`'s MCP tool list and `docs/application-evidence-snapshot.md` both match the shipped behavior, and no doc claimed anything about the old cleanup cadence or the absence of a fetch timeout.

### Missing updates (omission)

1. **`CHANGELOG.md`** — `CONTRIBUTING.md` (Repo map, and the pre-PR checklist) requires one line per PR under `## [Unreleased]`, plus a `package.json` version bump. Neither has happened yet. `/commit` performs both, so this is an ordering note rather than a defect, but the convention is not satisfied as the branch stands.
2. No other enumeration needs this feature: the retention behavior belongs to the existing source contract (updated), and the new constants are code-level, not environment variables, so the env-var documentation is unaffected.

### Internal consistency (doc ↔ doc, doc ↔ itself)

Run over every file the branch touched, **after** the last fix commit (`33e369d`).

- **Anchors:** `plan.md`'s `§5`/`§2` references and all `D1`–`D6` IDs resolve; ACs Plan-refs all match deliverable IDs (Gate 1 green).
- **Deictics:** none of the touched docs use "above/below/following" for a referent this branch moved.
- **Counts:** the ACs doc's 17 rows match the 17 verdicts recorded; test counts quoted in QC cells (43, 766) match the current run.
- **Retraction propagation:** the only retraction is the unbounded prune. Grep for "each snapshot whose creation time is older" returns nothing outside the corrected text; `docs/application-evidence-snapshot.md` and AC-FN-1 both state the bound. The plan does not — that is stale claim 2 and 3 above.
- **Same-document contradiction:** none found.

## Docs hygiene / public-voice audit

| Finding | Kind | Location | Introduced or pre-existing |
|---------|------|----------|------------------------------|
| None introduced | — | — | — |

The branch diff was grepped for private repo/org/agent names and operational hosts: no hits. One earlier slip (an AC evidence cell that quoted the forbidden-name list itself) was caught and removed before review; the live branch and the published issue comments were re-read from GitHub to confirm. Pre-existing references to the sibling automation repo in `README.md` and `docs/appendix/` predate this branch and are unchanged.

## Recommendations

1. Update `plan.md` §2, §5 O2 and row D1 to describe the batched prune and to record the reclaim as already performed, with its measured before/after.
2. Add the `## [Unreleased]` CHANGELOG line (and let `/commit` do the version bump) before opening the PR.
3. Optional, deferred lows from the OCR round are listed in the PR description rather than fixed here: the page RPC's empty-page race during a prune, a route-level sweep line covered only by code review, and three test-quality nits.

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
