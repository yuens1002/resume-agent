# Evidence snapshot retention and degraded-database resilience: plan

**Issues:** #285 (snapshot retention), #286 (bounded Supabase fetch, single-flight token cleanup)
**Branch:** `feat/evidence-snapshot-resilience` · **Cadence:** Full · **Execution:** `/agentic-orca` Implement + Verify
**Acceptance criteria:** `ACs.md` · **Review report:** `review.md` · **Status:** plan approved 2026-09-19; implemented and verified (17/17 ACs), awaiting human review

## 1. Why

A real deployment on the smallest compute tier (~1 GB RAM) became unresponsive twice in two days. The database stopped accepting connections until it was restarted. Evidence from that incident:

- `application_evidence_snapshot_entries` reached **307 MB (18 MB heap, the rest TOAST)**, 73% of the database. A downstream consumer called `create_application_evidence_snapshot` every 30 minutes, and each call materialized every application's evidence again. Nothing deletes old snapshots. The polling rate is being fixed by that consumer. This plan makes the server not depend on it.
- The instance swapped about 550 MB constantly. IOwait spikes lined up with both outages, and the disk IO budget was near depletion.
- While the database was degraded, `/token` requests stayed open for about **122 s** (the shared client has no fetch timeout).
- The OAuth token-cleanup `DELETE` was the most frequent timed-out statement (70 in one episode, 18 in the next). It fires every 60 s with no in-flight guard.

## 2. Decisions (owner-approved 2026-09-19)

- **Retention is 24 hours**, pruned inside `create_application_evidence_snapshot()` in the same transaction, with no scheduler. A pruned ID already returns `snapshot_not_found` (`P0001`) from `get_application_evidence_snapshot_page`, so the page contract does not change.
- **Out of scope:** reusing an unchanged snapshot instead of materializing a duplicate (#285 option 2). Retention plus the consumer fix bound growth. Revisit only if storage grows again.
- **The one-time reclaim** (`VACUUM FULL application_evidence_snapshot_entries`) is not part of the migration, because `VACUUM FULL` cannot run inside a transaction and takes an exclusive lock. It was performed by hand, with owner approval, on **2026-09-19 at 15:18Z**, before this branch merged: 222 expired snapshots deleted, the entries table 307 MB → 83 MB, the database 406 MB → 182 MB. §5 records what remains.
- **The prune is bounded per call** (`application_evidence_snapshot_prune_batch()`). An unbounded prune would put the whole backlog in one request-path transaction, and any client abort — including this branch's own fetch ceiling — would roll it back and leave the next call to repeat it.

## Deliverables

| ID | Deliverable | Kind | Role | Files |
|---|---|---|---|---|
| D1 | Forward migration redefining `create_application_evidence_snapshot()` to delete snapshots older than the retention window in the same transaction, oldest first and bounded per call; retention and the per-call bound each defined once (`application_evidence_snapshot_retention`, `application_evidence_snapshot_prune_batch`) | database | backend-architect | new `supabase/migrations/<timestamp>_application_evidence_snapshot_retention.sql` |
| D2 | PGlite tests for D1: pruning, in-window paging, pruned-ID refusal, retention defined once | verification | backend-architect | `tests/application-evidence-snapshot-retention.test.ts`, `package.json` (`test:application-evidence-source`, `test:unit` if applicable) |
| D3 | Source-contract doc update: retention semantics, and a reader must finish paging within the window | documentation | backend-architect | `docs/application-evidence-snapshot.md` |
| D4 | Bounded fetch for the shared Supabase client: `global.fetch` wrapped with `AbortSignal.timeout`, as one named timeout constant; profile-cache timeout reuses or deliberately stays separate (decision recorded in code comment) | library | backend-architect | `src/lib/supabase.ts` (and `src/lib/profile-cache.ts` only if reconciled) |
| D5 | Single-flight OAuth token cleanup: extract the prune timer into a testable function that skips a tick while a prune is pending; prune interval as a named constant, lengthened from 60 s (refresh tokens live for days) | library | backend-architect | `src/routes/oauth.ts` (or a new `src/lib/oauth-token-cleanup.ts`) |
| D6 | Tests for D4 and D5 with never-resolving stubs and fake timers; registered in `test:unit` | verification | test-engineer | `tests/supabase-fetch-timeout.test.ts`, `tests/oauth-token-cleanup.test.ts`, `package.json` |

## 3. Orca streams

Streams share one repo, so each runs in its **own git worktree** on its own sub-branch cut from `feat/evidence-snapshot-resilience`. That holds even with no file overlap, since the collision is the checked-out branch. The main thread merges each verified sub-branch into the feature branch. `package.json` is touched by two streams (test registration). That is a known, mechanical merge point, resolved at integration by keeping both entries.

| Stream | Deliverables | Sub-branch | Agent |
|---|---|---|---|
| A: retention | D1, D2, D3 | `feat/evidence-snapshot-resilience-a` | `backend-architect` |
| B: resilience | D4, D5 | `feat/evidence-snapshot-resilience-b` | `backend-architect` |
| C: resilience tests | D6 | `feat/evidence-snapshot-resilience-c`, cut after B lands | `test-engineer` (independent of B's author, per the retro rule on the same agent writing both the module and its tests) |

## 4. Verification notes

- Verify for D1 must call the RPC directly under PGlite with timestamps it constructs itself: one snapshot just inside the window and one just outside. Do not reuse D2's fixtures.
- Verify for D5 must drive the extracted function with a prune that never resolves and a prune that rejects. The guard must release on rejection, not only on success.
- No test or AC pins the retention value as a literal. Tests read the named definition.

## 5. Post-merge operations (main thread, human-gated)

| Op | Action | Evidence |
|---|---|---|
| O1 | Deploy (the target deployment redeploys on merge to `main`) and apply the migration | Migration listed as applied; `/health` 200 |
| O2 | Already done (2026-09-19 15:18Z, §2): the expired backlog was deleted and `VACUUM FULL application_evidence_snapshot_entries` reclaimed the space. After deploy, confirm the automatic prune keeps up — each create prunes at most one batch, so a new backlog drains over consecutive calls | `pg_total_relation_size` and the count of snapshots older than the window |
| O3 | Next day: snapshot rows older than 24h = 0; swap and IO budget trend down | Query + dashboard read |
| O4 | Close #285 and #286 with the evidence | Issue comments |
