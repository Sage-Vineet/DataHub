-- Migration: Data Room folder archive state
-- Purpose: allow folders to be archived/restored consistently with documents.

ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

SELECT pg_notify('pgrst', 'reload schema');
