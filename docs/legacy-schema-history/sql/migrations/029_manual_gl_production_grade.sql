-- ============================================================================
-- Migration 029: Manual GL Production Grade Hardening
--
-- Purpose:
-- 1) Enforce strict company-level isolation and duplicate staging prevention.
-- 2) Add dataset_hash, fiscal_year_start, and fiscal_year_end to batches.
-- 3) Create unique constraints to prevent redundant report generation.
-- ============================================================================

-- ---- Add production-grade fields to manual_gl_batches -----------------------
ALTER TABLE manual_gl_batches
  ADD COLUMN IF NOT EXISTS dataset_hash TEXT,
  ADD COLUMN IF NOT EXISTS fiscal_year_start INTEGER,
  ADD COLUMN IF NOT EXISTS fiscal_year_end INTEGER,
  ADD COLUMN IF NOT EXISTS staged_at TIMESTAMPTZ DEFAULT now();

-- ---- Populate staged_at from processing_completed_at if missing -------------
UPDATE manual_gl_batches
SET staged_at = processing_completed_at
WHERE staged_at IS NULL AND processing_completed_at IS NOT NULL;

-- ---- Create Unique Constraint for Duplicate Prevention ----------------------
-- This ensures that for a given company and fiscal range, the same dataset 
-- (identified by hash) cannot be staged multiple times.
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_gl_batches_dedup
  ON manual_gl_batches(company_id, fiscal_year_start, fiscal_year_end, dataset_hash)
  WHERE dataset_hash IS NOT NULL 
    AND (status = 'staged' OR batch_status = 'active');

-- ---- Indexes for performance ------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_dataset_hash 
  ON manual_gl_batches(company_id, dataset_hash);

CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_fiscal_range 
  ON manual_gl_batches(company_id, fiscal_year_start, fiscal_year_end);
