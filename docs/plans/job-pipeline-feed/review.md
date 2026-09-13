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

## Amendment: #259 draft-feed repair (2026-09-13)

**Reviewed base:** `e36c9dadfb1d54dec67881fdd5460aa4ae99fd1b`; workspace
changes are the pending #259 commit. **Verdict:** clear for the bounded feed
repair. Draft snapshots are accepted by the runtime contract, remain in recorded
totals and stage counts, and are omitted only from due work by the forward RPC
migration. Cursor, unknown-stage refusal, private-route authentication, and
overflow behavior remain covered.

Independent review identified one P1 in the #258 writer path: the evidence-bundle
migration permits `job_applications.stage = draft`, but not the corresponding
`application_stages` history value; the current writer compensates by deleting the
application on a history failure. It also has no explicit operation that selects a
generated resume as the submitted one while moving a draft to applied. These are
outside the feed-only repair and are tracked separately in #260; no source or
production claim here treats a tailored resume as confirmed submission.

### #259 evidence

- `npm run build` passed.
- `npm run test:job-feed` passed 18 focused feed/auth tests: direct SQL insertion,
  summaries, overdue-draft exclusion, transition to applied, stable cursor replay,
  unknown-stage refusal, migration replay, private registration and auth.
- `npm run test:job-feed-postgres` passed an isolated PostgreSQL 16 chain with the
  evidence and forward feed migrations, then the existing commit/rollback ordering,
  migration-failure recovery and concurrent migration-replay scenarios.
- `npm run test:unit` passed 710 tests with synthetic, non-production service/model
  environment values. An unconfigured first attempt failed only at unrelated module
  environment guards; no source change was made to accommodate it.

### #259 docs and hygiene audit

README and workflow stage listings, the feed contract, plan and AC rows now name
draft semantics consistently. The contract distinguishes recorded rows from
confirmed submissions and names the prerequisite migration order. No changed
document adds private credentials, personal data, or a claim of deployed readback.
Anchor, count, deictic-reference, retraction-propagation and same-document
contradiction checks were clean after the final change. Production migration,
matching deployed source revision, authenticated feed readback, and downstream
outcome evidence remain release gates rather than source-test evidence.

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

- Initial verification inspected locking only: local PostgreSQL lacked
  postgres.bki and Docker was unavailable. On 2026-09-13 Docker became available;
  the added isolated PostgreSQL runner passed commit/rollback ordering, forced
  migration failure recovery and migration replay with a concurrent writer.
  The initial pass did not prove these properties; the new evidence does.
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

### External review fix round (2026-09-13)

Copilot round 1 on d2c16a7 found migration replay atomicity, aggregate ordering
and an AC-02 test combining two separately required mutations. All were valid:
the migration now owns BEGIN/COMMIT and locks the source table; both arrays order
inside jsonb_agg; stage/date mutations are tested separately. The suppressed
full-row JSON serialization concern was also fixed by selecting minimal fields
from a typed source row. Production code and test fixes receive independent
review before the second external round. A new numeric/date ordering test brings
the focused suite to 16; the four Docker scenarios are reported separately.

The operational runner uses psql -f - like db:push, not a single -c batch that
could hide missing explicit transaction boundaries. It injects failure and
delay at the trigger replacement boundary and checks actual subsequent writes.
Reference: PostgreSQL 17 aggregate-function ordering and explicit-locking docs.

Final fix-round evidence: independent AC verification reran 16 focused tests,
710 existing units, build and AC gate successfully. Production and test reviewers
each observed all four Docker scenarios pass. The test reviewer also removed the
transaction/lock boundary in memory in an isolated database; the preservation
assertion failed (zero triggers instead of one), proving it catches the original
defect. No production access was used for these tests. Main-thread holistic
recheck reconciled the contract, AC correction, plan refinement, changelog and
test scripts against the final diff; no remaining source blocker found.

Base checks for the fix: actual db:push and sibling migration were read; official
PostgreSQL aggregate/lock references consulted; state stays in the source DB;
existing feed schema and registration remain shared; no new variants, business
labels or abstraction introduced; minimal field projection retains the declared
contract. New operational test runner uses explicit synthetic-only resource names
and no deployment credentials. Duplication check found no second feed consumer.
Claims above are executed observations, not inferred from a successful build.

2026-09-13: operator explicitly approved merge, production activation and
verification, with discovered deficiencies tracked and #256 closed only after
its source acceptance is proven. Live proof is a post-deployment gate, not a
merge prerequisite. Release version prepared: 0.4.115. The approval does not
stand in for a real job-follow-up disposition or authorize an outbound message.

Review the ACs and this report before release. No migration, deployment, merge,
version release or operator delivery has occurred. The workflow release and
post-release retrospective phases remain pending. The planned multi-commit
sequence was consolidated into one reviewed source commit; see plan.md.
