# Application evidence source acceptance criteria

Plan: `plan.md`. Status cells intentionally remain unmarked until independent
verification.

| AC | Deliverable | What | Pass |
|---|---|---|---|
| AC-01 | D1 | New JD writes retain immutable text, URL, capture time, and stable identity; legacy records remain explicitly unversioned | SQL fixture proves both paths |
| AC-02 | D1/D3 | New score records retain model, rubric/profile hashes, JD-version ID, and the evaluated resume ID without overwriting earlier scores | Writer and database fixtures preserve A, B, and both scores |
| AC-03 | D1/D2 | More than 100 detailed records are retrieved through a materialized snapshot with count reconciliation | Synthetic 101-row fixture returns every ordinal exactly once |
| AC-04 | D1/D2 | Pages remain stable after source mutation, and invalid snapshot/cursor/limit inputs refuse precisely | Readback fixture exercises mutation and invalid paths |
| AC-05 | D1/D2 | A recorded confirmation names the exact resume, distinct server-recorded/client-attested times, and truthful client source/ref; records without it stay unverified | Synthetic draft-confirmation and legacy fixtures preserve the distinction |
| AC-06 | D1 | Existing draft confirmation and feed contracts remain intact | Existing focused SQL suites stay green |
| AC-07 | D3 | Snapshot and artifact tools are private-only and transport schemas reject malformed input before source use | Local authenticated/public transport checks |
| AC-08 | D3 | Artifact reader resolves only a stored application/resume pair, caps size, verifies bytes/hash, and never accepts arbitrary paths | Synthetic wrong-pair, size, unavailable, and mismatch fixtures refuse precisely |
| AC-09 | D5 | Contract documents sensitive-field exclusions, snapshot semantics, provenance limits, artifact reads, and migration/deployment separation | Documentation review against schemas and SQL |
