# Job pipeline feed

Branch: `codex/job-pipeline-feed`. Full agentic-workflow cadence.

User approved the summary + changes + due-work contract and implementation on 2026-09-12. Backend-architect owns this backend feature, applying engineering-base. No UI/admin preflight applies to this private MCP addition. Build/tests run locally with synthetic database fixtures. Production migration and activation are separate release gates.

## Outcome

Provide a structured private feed that gives a decision consumer reliable totals over recorded applications, changes after an acknowledged cursor, and open follow-ups whose dates are due. Preserve the existing interactive list_applications contract. Tracking: #256.

## Discovery and design

Actual writers call resume-agent log_application and update_stage (job-hunt-agent/src/ob1.ts). The OB1 extension uses different tables and is not the target. Existing list_applications defaults to 20, caps at 100, formats prose, and upcoming_followups excludes overdue work. Existing log_application writes application and stage history in separate requests; the feed must not treat these as atomic or infer verified real-world submission from a row.

Add a private journal of minimal application-state changes through database triggers. Serialize journal sequence allocation with a transaction advisory lock, so a committed high-water cursor cannot jump an earlier uncommitted journal write. Application rows cover current stage and follow-up updates; stage-history records are not a second source of the same transition. Changes preserve each observed application mutation, including deletions; no claim of email-body or contact-only change capture. Initial migration does not fabricate historical change events.

A single SQL statement reads totals, journal changes, and due work at one MVCC snapshot. Totals describe all currently recorded applications and their current stage, including drafts, not just changed rows. Baseline (no cursor) returns no historical changes and a cursor. Cursor identifies the journal instance plus sequence; reject wrong-instance or future cursors. Bound output explicitly: if changes or due work exceed the batch ceiling, return an error without a checkpoint; never silently truncate. Due dates use an explicit IANA timezone and are reevaluated even when no row changed. Pre-submission drafts and terminal rejected/withdrawn applications are excluded from due work; offers remain actionable.

The reader never acknowledges processing. It returns a proposed next cursor; shared consumer owns durable acknowledgement after successful Runtime processing. A source error returns a typed refusal with no next cursor. The tool is additive on private MCP only; no new public route or broader credential grants.

## Deliverables

| ID | Deliverable | Kind | Owning role |
|---|---|---|---|
| D1 | Supabase journal and snapshot RPC migration | migration | /backend-architect |
| D2 | Validated feed contract and database adapter | resolver | /backend-architect |
| D3 | Private MCP registration using existing authentication | endpoint | /backend-architect |
| D4 | Executable SQL and adapter/transport verification | test | /backend-architect |
| D5 | Consumer contract, migration/activation evidence gates, docs | document | /backend-architect |

## Sequence

Release refinement (2026-09-13): D4 also includes the disposable Docker/psql
runner scripts/verify-job-feed-postgres.mjs for two-connection ordering and
migration replay/failure recovery. The migration owns its transaction boundary
because the existing db:push runner does not supply one. This is part of D1/D4,
not a new downstream consumer implementation.

1. Plan and ACs; mechanical coverage and anti-drift checks.
2. Implement D1-D3 and D4; build and relevant regression suite.
3. Independent AC verification, line-level review, holistic review, human review.
4. Release/migration only with verified artifacts and a concrete production rollout. Shared loop activation remains dependent on the cross-repo appendix.

## Commit schedule

Planned: plan/ACs commit; implementation commit; verification/review commit.
Actual: plan and implementation were staged together during the approved iteration;
one reviewed source commit captures both with verification artifacts. No historical
commit sequence is fabricated. Human release review follows.

## Dependencies

See ../../appendix/cross-repo/job-pipeline-decision-loop.md. No success-path Runtime contract is assumed. Consumer integration must be tested against the actual landed API before activation.
