-- Migration: Fix request_reminders foreign key to cascade delete
-- Purpose: Ensures deleting a request also deletes its reminders.
-- Date: 2026-05-22

DO $$
BEGIN
  ALTER TABLE request_reminders DROP CONSTRAINT IF EXISTS request_reminders_request_id_fkey;

  ALTER TABLE request_reminders ADD CONSTRAINT request_reminders_request_id_fkey
    FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;
