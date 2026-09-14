# Application evidence source

Branch: `codex/application-evidence-snapshot`
Tracking: [#263](https://github.com/yuens1002/resume-agent/issues/263)

Status: implementation plan. This source-only change establishes the bounded
private evidence contract requested by cot-memory's job-conversion program; it
does not deploy, start that program, create Runtime work, or assert a real
submission.

## Problem

The existing private feed is intentionally minimal and the interactive
application list is capped at 100 rows. The detailed per-application reader
cannot enumerate an entire cohort. Pages assembled from live rows would also
mix versions when a writer changes an application between calls.

## Contract

Two private MCP tools form one materialized reader:

1. `create_application_evidence_snapshot` creates an immutable source snapshot
   and returns its opaque identifier, source `as_of` timestamp, and count.
2. `get_application_evidence_snapshot_page` reads one bounded page from that
   snapshot using its opaque identifier and ordinal cursor. It returns a final
   page marker only when that response ends the materialized snapshot; callers
   reconcile all page ordinals to the declared count.

Each snapshot entry contains current application fields, immutable JD versions
when available, explicitly-labelled legacy unversioned JD text when present,
resume-version metadata/content and durable file hashes/paths, append-only
score records, internal submission-confirmation events, and stage timestamps.
It omits contacts, notes, and file bytes.

Artifact paths and hashes identify private stored DOCX/PDF blobs. The bounded
private byte reader resolves only an application/resume ID pair through that
source-owned mapping, applies a strict size cap, and verifies the stored hash;
it never accepts an arbitrary URL or storage path.
The contract is private MCP only.

New `job_description` writes create an immutable version with text, source URL,
capture time, and content hash. Newly recorded scores reference that version
and record the exact profile and scoring-rubric hashes used at evaluation.
Existing records are not backfilled or relabelled: absent version fields remain
unknown.

An internal confirmation event records the selected resume, server recording
time, and a truthful client attribution/source reference. It may also retain a
client-attested actual-submission time, distinctly labelled and never inferred
from the application stage or `applied_at`. Neither field establishes ATS
acceptance. Applications without such an event, including legacy submitted
records, remain `unverified`.

Observed response outcomes are a separate, append-only evidence history. Each
event retains a source identity, source event identity, normalized event type,
optional occurrence time, server recording time, opaque source reference,
evidence hash, enum classification code, revision, and a correction-chain
predecessor when applicable. The reference and event identity are the same
`imap:<mailbox-hash>:<uidvalidity>:<uid>` tuple; no address, Message-ID, or
raw email text is retained. The server derives the canonical replay digest;
callers cannot supply it.
The source event identity plus source identity/revision is idempotent; a
conflicting replay refuses, and a correction appends a later revision only
after proving the same application and source identity as its predecessor.
Events never update application stages. The allowed event types are
`recruiter_contact`, `screen_scheduled`, `screen_held`,
`interview_scheduled`, `interview_held`, `cancellation`, `rejection`,
`withdrawal`, `offer`, `offer_accepted`, `job_started`, and
`other_response`. A generic or automated acknowledgement remains
`other_response`; no event is reconstructed from stage. `offer_accepted` and
`job_started` require explicitly attributed source content, not an offer or a
label. `action_required` is optional and can be false only when explicit
observed content establishes it.

Outcome coverage is not an outcome. It is an append-only check observation
that declares the actual reader channel, period start/end, query scope,
complete flag, status (`observed`, `no_response`, or `unknown`), and server
recording time. `no_response` is only a scoped producer receipt for the
existing granted INBOX reader, never an all-channel absence claim. It requires
a successfully drained reader receipt with opaque mailbox/UIDVALIDITY/count
binding, a bounded application-relevant window, and complete coverage; a
partial, capped, failed, or ambiguous read is `unknown`. Applications with
immutable outcome history cannot be deleted implicitly. Snapshot entries
retain all event revisions and all coverage observations immutably.

## Deliverables

| ID | Deliverable | Kind |
|---|---|---|
| D1 | Forward migration for immutable JD versions, score and confirmation provenance, materialized snapshots, and service-only RPCs | database |
| D2 | Zod schemas and adapters for snapshot pages and artifact retrieval | library |
| D3 | Private MCP registration, bounded verified artifact reader, and score-writer provenance binding | endpoint |
| D4 | Isolated SQL, adapter, and transport tests using synthetic rows | verification |
| D5 | Source-contract documentation | documentation |
| D6 | Append-only observed-outcome and reader-coverage migration, bounded private MCP writes, and snapshot history | database/endpoint |

## Boundaries

- No scoring algorithm, model-selection, application-stage, or submission
  transition redesign; confirmation provenance is additive only.
- No guessed legacy capture, profile, rubric, submission, or outcome data.
- A selected resume is actor-attributed evidence, not independent proof that an
  external ATS accepted a submission.
- No raw email body is stored in source outcome history; no mail reader,
  outbound mail, or access grant is added here.
- No production migration, deployment, or live test data is part of this work.
