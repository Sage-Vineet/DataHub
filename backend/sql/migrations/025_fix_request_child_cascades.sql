-- Migration: Fix request_documents and request_narratives foreign keys to cascade delete
-- Purpose: Ensures deleting a request cascades to its documents and narratives.
-- Date: 2026-05-22

DO $$
BEGIN
  -- request_documents
  ALTER TABLE request_documents DROP CONSTRAINT IF EXISTS request_documents_request_id_fkey;
  ALTER TABLE request_documents ADD CONSTRAINT request_documents_request_id_fkey
    FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE;

  -- request_narratives
  ALTER TABLE request_narratives DROP CONSTRAINT IF EXISTS request_narratives_request_id_fkey;
  ALTER TABLE request_narratives ADD CONSTRAINT request_narratives_request_id_fkey
    FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;
