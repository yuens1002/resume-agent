# Evidence snapshot retention and degraded-database resilience: acceptance criteria

Plan: `docs/plans/evidence-snapshot-resilience/plan.md` · Branch: `feat/evidence-snapshot-resilience`

Pass conditions are **invariants**, not equality against a config literal. No test or Pass cell pins the retention window, timeout or interval value; tests read the named definition. Agent/QC/Reviewer cells stay empty until independent verification.

| ID | Plan ref | Role | Acceptance criterion | Pass (invariant) | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-1 | D1 | backend-architect | Creating a snapshot prunes expired ones | After a create call, no snapshot older than the retention window remains; every snapshot inside the window, including the new one, remains, with all its entries | | | |
| AC-FN-2 | D1 | backend-architect | Pruning cascades to entries | After a prune, no `application_evidence_snapshot_entries` row references a deleted snapshot | | | |
| AC-FN-3 | D1 | backend-architect | Paging inside the window is unaffected | A snapshot created inside the window pages end to end through `get_application_evidence_snapshot_page` with every ordinal returned exactly once, including after a later create call has run its prune | | | |
| AC-FN-4 | D1 | backend-architect | A pruned snapshot refuses cleanly | Paging a pruned snapshot ID yields the existing `snapshot_not_found` refusal (P0001 at the RPC, the named refusal at the MCP tool), not an error or an empty page | | | |
| AC-FN-5 | D1 | backend-architect | Retention is defined once | Exactly one definition of the retention window exists in the migration; the create RPC and tests reference it by name | | | |
| AC-FN-6 | D1 | backend-architect | The migration is forward-only and preserves grants | The redefined RPC keeps its existing execute grants (service role only; not anon or authenticated) and security settings; the repo's security-definer audit still passes | | | |
| AC-FN-7 | D4 | backend-architect | Shared client calls are time-bounded | With an underlying fetch that never resolves, a query through the shared client rejects within the named timeout plus a small tolerance | | | |
| AC-FN-8 | D4 | backend-architect | Normal calls are untouched | With a fetch that resolves, responses pass through unchanged, and a caller-supplied abort signal is still honored (combined, not replaced) | | | |
| AC-FN-9 | D5 | backend-architect | Cleanup never overlaps itself | With a prune that never resolves, advancing fake timers across several intervals issues exactly one prune call | | | |
| AC-FN-10 | D5 | backend-architect | The guard releases on failure | After a prune rejects, the next tick issues a new prune; a rejection is logged and never throws out of the timer | | | |
| AC-FN-11 | D5 | backend-architect | In-memory auth-code sweep is preserved | Expired authorization codes are still evicted on their own cadence, independent of the database prune's state | | | |
| AC-FN-12 | D5 | backend-architect | The timer does not hold the process open | The cleanup timer is unref'd, as today | | | |
| AC-TST-1 | D2 | backend-architect | Retention tests run in the SQL suite | The new PGlite test file is registered in `test:application-evidence-source` and executes | | | |
| AC-TST-2 | D6 | test-engineer | Resilience tests run in the unit suite | The new test files are registered in `test:unit` and execute; none needs network or `.env.local` | | | |
| AC-DOC-1 | D3 | backend-architect | The source contract states retention | `docs/application-evidence-snapshot.md` states the window by referencing its named definition, that readers must finish paging inside it, and that a pruned ID returns `snapshot_not_found` | | | |
| AC-REG-1 | — | test-engineer | No regression | `npm run build` passes; `test:unit` and `test:application-evidence-source` pass with no fewer tests than `main` | | | |
| AC-PUB-1 | — | backend-architect | Public-repo hygiene | No file, commit message, or PR text on this branch names a private repo, org, client, host, or operational URL (CONTRIBUTING's Public-Repo Rule); checked on the live PR body, not a draft | | | |
