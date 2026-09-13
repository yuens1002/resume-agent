# Job pipeline feed acceptance criteria

Plan: plan.md. Role for every row: /backend-architect. Reviewer cells are reserved for the operator.

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|---|---|---|---|---|---|---|---|---|
| AC-01 | D1 | /backend-architect | Totals and baseline | Executable SQL | More than the interactive list cap are counted; baseline reports no fabricated changes and returns a cursor | PASS (source scope) | PASS — independent verification and review; see review.md | |
| AC-02 | D1 | /backend-architect | Changes and replay | Executable SQL | Insert, stage change, follow-up change and delete appear after prior cursor; retry returns the same change IDs; rollback emits no change | PASS (source scope) | PASS — independent verification and review; see review.md | |
| AC-03 | D1 | /backend-architect | Clock-driven due work | Executable SQL | Due and overdue open applications appear without a new mutation; future and terminal entries do not | PASS (source scope) | PASS — independent verification and review; see review.md | |
| AC-04 | D1 | /backend-architect | Isolation and bounded output | SQL tests and locking review | Journal allocation is serialized until transaction end; response reads one snapshot; overflow and foreign/future cursors fail without a checkpoint | PASS (source scope) | PASS — independent verification and review; see review.md | |
| AC-05 | D2 | /backend-architect | Typed contract | Adapter tests | Valid source payload passes schema; malformed/error/exception returns refusal and no next cursor; input constraints enforced | PASS (source scope) | PASS — independent verification and review; see review.md | |
| AC-06 | D3 | /backend-architect | Private registration | MCP transport test | New tool is callable through its registration; output matches schema; public registration excludes it and authentication still gates private route | PASS (source scope) | PASS — independent verification and review; see review.md | |
| AC-07 | D4 | /backend-architect | Verification fidelity | Build, SQL and unit suite | Tests execute production SQL and adapter code with synthetic data; existing unit suite and typecheck pass | PASS (source scope) | PASS — independent verification and review; see review.md | |
| AC-08 | D5 | /backend-architect | Honest handoff | Review docs against code | Contract describes baseline, total semantics, cursor acknowledgement, overflow, timezone, migration and shared-loop dependencies; live proof remains explicitly pending | PASS (source scope) | PASS — independent verification and review; see review.md | |

Thesis evidence is a separate activation gate in the cross-repo appendix. It cannot be marked passed by these source ACs.

Initial AC-04 concurrency evidence was inspection only. On 2026-09-13 the isolated PostgreSQL runner additionally passed commit/rollback ordering, migration failure recovery and concurrent migration replay. AC-06 remains local transport/auth and SQL privileges, not deployed access. External review then corrected migration atomicity, aggregate ordering and AC-02's combined-mutation coverage; final release verification must include those fixes. The original 15-test pass did not prove them.
