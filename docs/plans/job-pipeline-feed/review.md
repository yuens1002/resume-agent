# Job pipeline feed: verification and review

Date: 2026-09-12. Branch: codex/job-pipeline-feed.
Base: 8b8514fb62055597d575039bca8928335837dc63 (origin/main rechecked).
Scope: source implementation and artifacts in this commit, not a production deployment.
Tracking: https://github.com/yuens1002/resume-agent/issues/256

## Verdict

Source AC-01 through AC-08 pass within their documented evidence boundaries.
Independent AC verification, line-level code/test review and main-thread holistic
review are complete. Human Reviewer cells remain blank. Release and the overall
decision-loop thesis are NOT verified.

## Executed evidence

- npm run test:unit: 15 focused feed tests via pretest, then 710 existing unit
  tests; all passed, none skipped. Synthetic environment only.
- npm run build: TypeScript passes.
- AC coverage and anti-literal-drift gate pass through the focused test script.
- Migration-preservation test also passes alone: one test, with its own nonempty
  journal fixture.
- Staged and unstaged whitespace checks pass.

Tests execute the new production migration in embedded PostgreSQL. The original
schema fixture omits only unsupported pg_trgm extension/index setup. They exercise
more than 100 rows, replay, rollback, due dates/timezones, cursor rejection,
overflow, SQL privileges, adapter parsing, actual MCP registration and private/
public route discovery. They do not execute a deployed Supabase/PostgREST request.

## Independent review and corrections

Read-only reviewers: verify_job_feed (ACs), review_job_feed_code (production),
review_job_feed_tests (test fidelity). All returned final passes.

The initial AC pass did not discover every defect. Subsequent line review found:

1. Passing a schema shape to the MCP SDK stripped unknown cursor keys, allowing a
   typo to become an unintended baseline. Full strict schema now reaches the SDK.
2. Malformed sequence text could throw during BigInt refinement. Conversion now
   has format/length guards and tests require zero RPC calls.
3. Invalid-input callback assertions could be swallowed by the adapter. Explicit
   call counters and refusal assertions replace that weak evidence.
4. RPC forwarding tests used closure values instead of actual forwarded arguments.
   They now assert all arguments and execute those arguments, including timezone.
5. A downstream permission denial could mask RPC execute permission. Tests now
   check the function privilege itself.
6. Public-tool exclusion could pass on an HTTP-success RPC error. Tests require a
   parsed successful, nonempty tool listing before checking exclusion.
7. Migration-history equality could compare two empty journals in isolation.
   The test now seeds and asserts its own nonempty journal.

Each finding was corrected and independently rechecked. Production review covers
SQL, adapter, MCP helper/registration, package wiring and AC gate. Test review
covers both new test files, including files excluded by default OCR path rules.
The prescribed Fable reviewer model was unavailable; inherited-model independent
reviewers were substituted explicitly. This is not a claim that Fable ran.

## Holistic and engineering-base review

Discovery identified the actual source writers and schema before editing.
Layer boundary: source owns observed application state; downstream Runtime owns
decisions, responsibility, acknowledgement and outcomes. No second queue or
operator-response implementation is introduced. Existing authentication and MCP
registration are reused; adapter and schema are shared by registration and tests.
Field/stage definitions are explicit, bounded and grep-searchable. No UI or admin
surface is added. No seed/scaffold literal pinning applies.

D1 maps to the migration; D2 to typed schema/adapter; D3 to private registration;
D4 to executable tests/gate; D5 to contract, README, architecture, changelog and
cross-repo boundary. Documentation and implementation agree on baseline,
recorded-row totals, cursor acknowledgement, due-work recurrence and refusal.
Input example conforms to the strict schema. No public route or private source
payload was added to documentation. Diff review found no unrelated changes.

## Carried deficiencies and activation gates

- The database journal lock ordering and STABLE snapshot are inspected, not
  experimentally verified with two concurrent connections. Local PostgreSQL
  lacked postgres.bki and Docker had no running daemon. No database was started
  and no production connection was used. Commit/rollback ordering needs a
  two-connection check before activation.
- Migration application and deployed authenticated readback are pending.
- The existing private MCP credential remains broader than read-only (#247).
- Unlogged submissions, historical data contamination and conversion definitions
  are not solved. Totals describe currently stored rows, not verified submissions.
- Batches exceeding 1000 changes or due items refuse without advancing a cursor;
  automatic catch-up/pagination is not implemented.
- Shared Runtime intake, queue projection, delivery and outcome handling must
  land and be validated against their actual contracts before consumer activation.

End-to-end acceptance requires one real due follow-up, its source cursor, Runtime
work ID, projection/delivery receipt, operator disposition, action evidence or
dated deferral, terminal run state and a duplicate-free next run. Source tests
cannot substitute for these receipts.

## Human handoff

2026-09-13: operator explicitly approved merge, production activation and
verification, with discovered deficiencies tracked and #256 closed only after
its source acceptance is proven. Live proof is a post-deployment gate, not a
merge prerequisite. Release version prepared: 0.4.115. The approval does not
stand in for a real job-follow-up disposition or authorize an outbound message.

Review the ACs and this report before release. No migration, deployment, merge,
version release or operator delivery has occurred. The workflow release and
post-release retrospective phases remain pending. The planned multi-commit
sequence was consolidated into one reviewed source commit; see plan.md.
