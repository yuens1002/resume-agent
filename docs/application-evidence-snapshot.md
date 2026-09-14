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

Entries are materialized at creation time, so a later application update never
changes a page from an existing snapshot. The snapshot is intentionally not an
acknowledgement, submission confirmation, or external-ATS acceptance record.

## Evidence and provenance

The response includes application fields; immutable JD versions; explicitly
labelled legacy JD text when no version exists; resume-version content and
artifact paths/hashes; append-only score history; internal submission-
confirmation events; and stage timestamps.

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
and SHA-256 content hash. New `log_application` score-history rows retain the
evaluated resume ID when supplied, JD-version ID, model, rubric version and
hash, and the hash of the exact serialized profile input. The feature never
backfills historical JD, profile, rubric, resume, or score provenance: null or
`legacy_unversioned` means the source did not retain that fact.

## Refusals

Malformed tool inputs return `invalid_input`. The page reader maps a missing
snapshot to `snapshot_not_found`, an invalid cursor or page limit to
`invalid_cursor_or_limit`, and source/RPC failures to a non-diagnostic refusal.
