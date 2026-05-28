-- Migration: Ensure document_status enum has all required values
-- Purpose: Fixes 'invalid input value for enum document_status: "under-review"'
--          which happens if the live DB's enum was created with 'under_review'
--          instead of the expected 'under-review' used by the frontend and backend.
-- Date: 2026-05-20

-- In PostgreSQL, adding to an enum is safe and idempotent with IF NOT EXISTS
ALTER TYPE document_status ADD VALUE IF NOT EXISTS 'under-review';
ALTER TYPE document_status ADD VALUE IF NOT EXISTS 'verified';
ALTER TYPE document_status ADD VALUE IF NOT EXISTS 'rejected';
