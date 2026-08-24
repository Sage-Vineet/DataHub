-- ============================================================================
-- Migration 036: Add 'in-review' to request_status enum
-- ============================================================================
-- The schema defines request_status as:
--   ENUM ('pending', 'in-review', 'completed', 'blocked')
-- Migration 028 added 'blocked' but 'in-review' was never added to the live DB.
-- Without this value, updating a request status to 'in-review' (e.g. when a
-- client uploads a document or saves a narrative response) fails with:
--   "invalid input value for enum request_status: in-review"
-- This migration is idempotent: safe to re-run.
-- ============================================================================

DO $$
BEGIN
  ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'in-review';
EXCEPTION WHEN others THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
