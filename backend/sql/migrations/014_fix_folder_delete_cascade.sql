-- Migration: Update folders parent_id foreign key to CASCADE delete
-- Purpose: Fixes folder deletion errors when a folder has children.
-- Date: 2026-05-20

DO $$
BEGIN
  ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_parent_id_fkey;
  
  ALTER TABLE folders ADD CONSTRAINT folders_parent_id_fkey
    FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;
