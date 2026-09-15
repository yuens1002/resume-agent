# Application evidence source acceptance criteria

Plan: `plan.md`. Status cells intentionally remain unmarked until independent
verification.

| AC | Deliverable | What | Pass |
|---|---|---|---|
| AC-01 | D1 | New JD writes retain immutable text, URL, capture time, and stable identity; legacy records remain explicitly unversioned | SQL fixture proves both paths |
| AC-02 | D1/D3 | New score records retain model, rubric/profile hashes, one exact operation-bound JD-version ID, and the evaluated resume ID without overwriting earlier scores; unavailable JD provenance prevents score-history persistence | Writer and database fixtures preserve A, B, and both scores |
| AC-03 | D1/D2 | More than 100 detailed records are retrieved through a materialized snapshot with count reconciliation and one source/as-of read boundary | Synthetic 101-row and isolated concurrent-writer fixtures return every ordinal exactly once |
| AC-04 | D1/D2 | Pages remain stable after source mutation, and invalid snapshot/cursor/limit inputs refuse precisely | Readback fixture exercises mutation and invalid paths |
| AC-05 | D1/D2 | A recorded confirmation names the exact resume, distinct server-recorded/client-attested times, and truthful client source/ref; records without it stay unverified | Synthetic draft-confirmation and legacy fixtures preserve the distinction |
| AC-06 | D1 | Existing draft confirmation and feed contracts remain intact | Existing focused SQL suites stay green |
| AC-07 | D3 | Snapshot and artifact tools are private-only and transport schemas reject malformed input before source use | Local authenticated/public transport checks |
| AC-08 | D3 | Artifact reader resolves only a stored application/resume pair, caps size, verifies bytes/hash, and never accepts arbitrary paths | Synthetic wrong-pair, size, unavailable, and mismatch fixtures refuse precisely |
| AC-09 | D5 | Contract documents sensitive-field exclusions, snapshot semantics, provenance limits, artifact reads, and migration/deployment separation | Documentation review against schemas and SQL |
| AC-10 | D6 | Outcome events are immutable, source-attributed, revisioned, SHA-256-bound, atomically idempotent under concurrent replay, and never synthesize a stage or acceptance/job start | Isolated PostgreSQL replay/conflict/correction fixtures preserve every revision |
| AC-11 | D6 | Coverage checks preserve reader channel, bounded scope/window, completeness, unknown versus no-response semantics, and a database-computed SHA-256 replay identity | Isolated partial/failure/complete/concurrent fixtures refuse unsupported no-response claims |
| AC-12 | D6 | Snapshot exports all event and coverage histories through the existing bounded reader without exposing raw email content | Adapter and page fixtures validate private typed histories |
| AC-13 | D7 | Recovery verifies the exact application/company/role, downloads each deterministic private artifact after upload, checks its SHA-256 and size, then appends one explicitly non-submitted resume version | Unit and isolated SQL fixtures exercise success and readback |
| AC-14 | D7 | Equal retries reuse one recovery/resume identity; changed bytes, content, source or application identity fail closed without rewriting the prior record | Unit and database replay/conflict fixtures |
| AC-15 | D7 | Recovery preserves stage, scores, confirmations, outcomes and legacy JD ambiguity; original generation time remains explicitly unknown | Snapshot fixture compares before/after lifecycle evidence and provenance |
| AC-16 | D7 | The recovery operation is service-role-only and is not registered on either MCP surface | SQL privilege assertions and tool-registration inspection |
