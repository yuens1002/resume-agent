-- Optional identity tagline shown under the candidate's name in the web résumé.
-- Null for existing rows; falls back to preferred_roles display in the frontend.
alter table public_profile add column if not exists tagline text;
