# Application evidence snapshots

`create_application_evidence_snapshot` and
`get_application_evidence_snapshot_page` are private MCP tools for a bounded,
repeatable review of detailed application evidence. Apply
`20260914000000_application_evidence_snapshot.sql` before using either tool.
The migration and activation are separate release steps; this document is not
evidence that either has happened in an environment.

## Contract

Call `create_application_evidence_snapshot` with `{}`. It is a protected
write: it records a new immutable snapshot and returns:

```json
{
  "status": "ok",
  "snapshot": {
    "snapshot_id": "opaque UUID",
    "as_of": "source timestamp",
    "total_applications": 0,
    "snapshot_materialized": true
  }
}
```

Use that ID with `get_application_evidence_snapshot_page`, passing an optional
ordinal `after` cursor and a `limit` from 1 through 100. The page includes the
same snapshot metadata, detailed `applications`, a nullable `next_cursor`, and
`is_final_page`.

`is_final_page: true` means only that this response has reached the terminal
page for its snapshot. It does not assert that another consumer fetched or
processed any earlier page. A consumer reconciles its collected ordinals with
`total_applications` before it represents a cohort as complete.

Entries and the declared `as_of` are materialized from the same database read
boundary, so a later application update never changes a page from an existing
snapshot or appears under an earlier timestamp. The snapshot is intentionally
not an acknowledgement, submission confirmation, or external-ATS acceptance
record.

## Retention

Snapshots are short-lived read handles, not an archive. The retention window
is defined once, as the SQL function
`public.application_evidence_snapshot_retention()` in
`20260919000000_application_evidence_snapshot_retention.sql`; read the value
there rather than from this document.

Every `create_application_evidence_snapshot` call first deletes each snapshot
whose creation time is older than that window, in the same transaction that
records the new snapshot. Its entries are removed with it. No scheduler is
involved, so pruning happens only when a snapshot is created.

A reader must finish paging a snapshot inside the window. Once a later create
call has pruned it, `get_application_evidence_snapshot_page` refuses that ID
with `snapshot_not_found`, exactly as for an ID that never existed; it never
returns a partial or empty page for it. A consumer that sees this mid-page
starts again from a new snapshot rather than resuming.

Creating a snapshot re-materializes every application, so callers should
create one when they need a fresh read, not on a fixed polling schedule.

## Evidence and provenance

The response includes complete current application fields, including current
fit/match/recommendation values; immutable JD versions; explicitly labelled
legacy JD text when no version exists; resume-version content and artifact
paths/hashes; append-only score history; internal submission-confirmation
events; inbox-scoped outcome history/checks; and stage timestamps.

Snapshot pages exclude contacts, free-form application notes, and artifact
file bytes. The endpoint is private-only because resume content and job
descriptions can be sensitive.

`docx_url` and `pdf_url` are durable private-storage paths with hashes, not
download URLs. `get_application_resume_artifact` is the only source MCP byte
reader: it accepts application ID, resume ID, and `docx` or `pdf`; resolves the
stored path from that exact database row; enforces a 5 MiB limit; downloads
through the existing private bucket; and returns base64 bytes only after a
SHA-256 match. It never accepts an arbitrary URL or path. Missing, oversized,
unavailable, and hash-mismatched artifacts refuse without returning bytes.

An internal `confirm_application_submission` event is exposed separately from
resume `is_submitted` as `submission_confirmation`. A `recorded` confirmation
contains the exact selected resume ID, its server-recorded confirmation time,
the client-attested actual-submission time when provided, a client attribution
(`client_attested` or `unknown`), and optional client source reference. The
recorded time is not claimed to be the external send time, and no stage or
`applied_at` value is repurposed as one. Client attestation is not independent
ATS evidence. An application without a captured confirmation event, including
legacy submitted records, is `unverified` rather than guessed.

New JD writes create a version containing its text, source URL, capture time,
and SHA-256 content hash. A new `log_application` score-history row is written
only when its exact operation-bound JD version is available; it retains the
evaluated resume ID when supplied, JD-version ID, model, rubric version and
hash, and the hash of the exact serialized profile input. The feature never
backfills historical JD, profile, rubric, resume, or score provenance: null or
`legacy_unversioned` means the source did not retain that fact.

`record_application_observed_outcome` appends an attributed, revisioned inbox
event. `record_application_outcome_check` appends an inbox-reader coverage
observation. Both derive a canonical SHA-256 payload hash in the database and
make exact concurrent replays idempotent; a replay with changed content
refuses. Coverage is scoped evidence from the named reader, never proof that
all response channels were searched.

## Refusals

Malformed tool inputs return `invalid_input`. The page reader maps a missing
snapshot, including one pruned by retention, to `snapshot_not_found`, an
invalid cursor or page limit to `invalid_cursor_or_limit`, and source/RPC
failures to a non-diagnostic refusal.

## Source-owner recovery

`npm run admin:recover-evidence -- --manifest .scratch/recovery.json` is the
only historical resume-recovery entrypoint. It is an administrative process,
not an MCP tool. The private manifest pins an existing application ID plus its
exact company and role, stable recovery/resume UUIDs, a non-empty structured
resume-content file, one or both local DOCX/PDF files, and an opaque source
reference shaped like `job-hunt-agent:output:<identity>`. It accepts no source
endpoint, storage URL, submitted flag, score, stage, JD timestamp, or outcome.

The process hashes each local artifact, uploads it to the deterministic private
`<application-id>/<resume-id>/resume.<format>` path, downloads that exact path,
and applies the same 5 MiB/SHA-256 verifier as the private artifact reader.
Only then does the service-role-only `recover_application_resume_version` RPC
atomically append the non-submitted resume and its immutable recovery record.
Equal retries verify the existing bytes and return the same identities;
changed bytes, structured content, source reference, company, role, recovery
ID, or resume ID refuse. An upload completed before a failed RPC remains at its
deterministic path for the same safe retry rather than being silently deleted.

New snapshots label the version `provenance.status: recovered`, preserve its
server `recorded_at`, and set `original_generated_at: null` with
`original_generation_time_status: unknown`. Existing materialized snapshots
remain readable with their original immutable shape until the retention window
prunes them (see Retention). The legacy JD remains `legacy_unversioned`;
recovery never invents its historical capture time.
Application stage, scores, submission confirmations, outcomes, and prior resume
versions are outside the function's write set.
