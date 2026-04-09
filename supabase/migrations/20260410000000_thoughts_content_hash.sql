-- Add content_hash for idempotent re-runs of the enrichment sync.
-- Existing rows get NULL; unique constraint only applies where not null.
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS content_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS thoughts_content_hash_idx
  ON thoughts (content_hash) WHERE content_hash IS NOT NULL;
