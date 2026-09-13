# Job pipeline feed

`get_job_pipeline_feed` is an additive private MCP tool, available after applying
`20260912000000_job_pipeline_feed.sql` and deploying the matching application.
It returns JSON text containing `{status: "ok", feed}` or
`{status: "refused", code}` with MCP `isError`. It does not change applications
or acknowledge downstream processing.

Input: optional `cursor: {generation, sequence}` from a previous successful feed,
and `timezone` (IANA name, default UTC). Sequence is a decimal string to preserve
PostgreSQL bigint precision. Configure the operator's timezone explicitly.

For an initial read, call the private MCP tool with
`{"timezone":"America/New_York"}`. For subsequent reads, send the same timezone
and the exact `next_cursor` object from the last durably processed response as
`cursor`. Do not reset to an initial read when processing fails.

The feed contains:

- `summary.recorded_applications`: lifetime count of currently stored application
  rows, including terminal stages. Deleting a row reduces this count. This is not
  an independently verified total of real-world submissions. `by_stage` gives
  current counts; absent stages have zero stored rows.
- `changes`: relevant application inserts, updates, and deletes after the cursor,
  with stable journal sequence IDs and minimal source snapshots. Captured fields
  are identity, company, role, stage, applied time and follow-up date. Notes,
  resumes, contacts, raw email bodies and scoring details are not included.
- `due_work`: current open applications with follow-up date on/before the local
  date. Rejected/withdrawn entries are excluded. Offers remain actionable. This
  is evaluated even when changes is empty; passage of time is an input.
- `as_of`, `history_available_since`, `baseline`, `next_cursor`: provenance and
  processing boundary. All collections and totals use one database snapshot.

A baseline omits historical changes and proposes the current high-water cursor.
It still includes summary and due work. The journal starts at installation;
earlier changes cannot be recovered. A baseline is explicit initialization, never
an automatic recovery from a rejected cursor. A consumer must process baseline
due work too.

Keep the last acknowledged cursor until the entire batch has been durably
processed. On partial failure, retry with that same cursor. Journal IDs deduplicate
changes; an application ID plus follow-up date identifies a due-work occurrence.
Due items recur until the source date/stage changes; acknowledging a feed does not
resolve the decision. A consumer needs durable per-occurrence processing and
outcome state. An operator approval alone is not evidence of follow-up execution.

Foreign/future cursors and invalid timezone return `invalid_cursor_or_timezone`.
More than 1000 changes or 1000 due items returns `feed_overflow`; no partial result
or next cursor is returned. This version requires operator reconciliation for
overflow, not a reset to baseline that discards work. Source errors, absent
migration or transport failures return `source_unavailable`; malformed SQL
output returns `invalid_source_payload`. None acknowledge a batch.

The journal uses a transaction advisory lock before allocating sequence IDs.
Concurrent journal writers serialize until commit/rollback, preventing a later
committed sequence from overtaking an uncommitted earlier one. This adds write
contention and multi-row writers can encounter ordinary database deadlocks;
callers must handle a failed transaction as failure, not successful logging.
Out-of-band writes that disable triggers or replace tables invalidate the feed.

## Rollout and verification

The migration owns its BEGIN/COMMIT transaction; run the file through psql with
ON_ERROR_STOP, without wrapping it in another transaction. It takes a source-table
write lock (five-second acquisition timeout), so reapplication cannot expose a
missing-trigger window. Retry a lock timeout later, not by removing the lock.
It adds tables, a trigger and RPC; it does not backfill events or change existing
application values. Application writes fail if their journal append fails.
Reapplying preserves identity and history. Check migration status and the RPC
under the deployed service identity before enabling a consumer.

The RPC and journal are inaccessible to anonymous/authenticated database roles.
The MCP tool inherits private-route auth. A tool's read-only annotation does not
make the existing shared MCP credential read-only; credential scoping remains
tracked in #247.

Run `npm run test:job-feed` for real SQL in embedded PostgreSQL, schema/adapter
tests, MCP registration and private/public route tests. The embedded database is
single-connection: these tests do not demonstrate concurrent transaction behavior
or production deployment. Run `npm run test:job-feed-postgres` with Docker available
for isolated PostgreSQL 16 commit/rollback ordering, migration failure recovery and
concurrent migration replay checks. It uses no production credentials or network
and retains stopped test containers for inspection. Production activation also
requires an authenticated deployed readback. Record that evidence
separately; a successful build is not a live readback.

The external decision consumer must prove intake, queue visibility, delivery,
operator disposition and next-run reconciliation before claiming a closed loop.
See the cross-repo appendix for the boundary; this source tool cannot certify
those downstream effects.
