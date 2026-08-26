-- Migration: Add storage_path column to uploads, make data nullable
-- Allows files to be stored in Supabase Storage instead of as bytea in the DB.
-- Existing rows keep their bytea data; new uploads use storage_path.
-- Date: 2026-05-25

ALTER TABLE uploads ADD COLUMN IF NOT EXISTS storage_path text;
ALTER TABLE uploads ALTER COLUMN data DROP NOT NULL;
