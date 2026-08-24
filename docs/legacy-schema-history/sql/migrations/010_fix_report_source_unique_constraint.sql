-- Migration: Fix missing unique constraint on report_source_records
-- Purpose: The ON CONFLICT (company_id, source_key) clause in reportSourceStore.js
--          requires a unique constraint on those columns. The table may have been
--          created without one if migration 003 was skipped or partially applied.
--          This migration idempotently ensures the constraint exists, first deduping
--          any conflicting rows so the ADD CONSTRAINT succeeds.
-- Date: 2026-05-20

-- Step 1: Remove duplicate (company_id, source_key) rows, keeping the most recent
DELETE FROM report_source_records
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id, source_key) id
  FROM report_source_records
  ORDER BY company_id, source_key, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
);

-- Step 2: Add the unique constraint if it does not already exist
DO $$
BEGIN
  -- Try adding with the canonical name used in schema.sql / migration 008
  ALTER TABLE report_source_records
    ADD CONSTRAINT uq_report_source_records_company_source
    UNIQUE (company_id, source_key);
EXCEPTION
  WHEN duplicate_table THEN NULL;   -- constraint already exists (PG 9.x+)
  WHEN duplicate_object THEN NULL;  -- constraint already exists (PG 11+)
END $$;
