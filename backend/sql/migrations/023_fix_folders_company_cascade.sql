-- Migration: Fix folders company_id foreign key to cascade delete
-- Purpose: Ensures deleting a company also deletes its folders.
-- Date: 2026-05-22

DO $$
BEGIN
  ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_company_id_fkey;

  ALTER TABLE folders ADD CONSTRAINT folders_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;
