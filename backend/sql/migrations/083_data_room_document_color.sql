-- Migration: Data Room document colors
-- Purpose: allow files to store the user-selected display color.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS color text;

SELECT pg_notify('pgrst', 'reload schema');
