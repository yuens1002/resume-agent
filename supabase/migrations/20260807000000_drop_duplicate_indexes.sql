-- Drop the duplicate indexes that unnamed `create index` left behind (#237).
--
-- `create index on <table> (...)` with no name never errors on a re-run — PostgreSQL just
-- auto-generates a fresh name. So where the earlier migrations declared indexes without
-- names, replaying them did not fail loudly; it silently built a second, byte-identical
-- copy under a `…_idx1` name. Eight of them accumulated:
--
--   thoughts_embedding_idx1                            31 MB   ← hnsw, rebuilt on every write
--   thoughts_metadata_idx1                            400 kB
--   thoughts_created_at_idx1                          136 kB
--   job_applications_stage_idx1                        16 kB
--   job_applications_applied_at_idx1                   16 kB
--   job_applications_follow_up_date_idx1               16 kB
--   application_stages_application_id_occurred_at_idx1 16 kB
--   job_contacts_application_id_idx1                   16 kB
--
-- ~32 MB of storage, but the real cost is write amplification: every insert or update to
-- `thoughts` maintained two HNSW vector indexes instead of one.
--
-- Safe to drop: each `…_idx1` is identical in definition to the canonical `…_idx`, which
-- stays. No query loses an index. Verified identical by normalising indexdef and grouping,
-- rather than by assuming the naming convention implied it.
--
-- The migrations that created them now name their indexes explicitly and guard with
-- `if not exists`, so the canonical names match what is already there and no new copies
-- can appear. This file is the cleanup; those edits are the fix.
--
-- `if exists` throughout, so this is itself replay-safe on a database that never had the
-- duplicates — a fresh project, for instance.

drop index if exists thoughts_embedding_idx1;
drop index if exists thoughts_metadata_idx1;
drop index if exists thoughts_created_at_idx1;
drop index if exists job_applications_stage_idx1;
drop index if exists job_applications_applied_at_idx1;
drop index if exists job_applications_follow_up_date_idx1;
drop index if exists application_stages_application_id_occurred_at_idx1;
drop index if exists job_contacts_application_id_idx1;
