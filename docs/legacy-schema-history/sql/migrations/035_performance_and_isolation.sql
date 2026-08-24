-- ============================================================================
-- Migration 035: Manual GL Architecture Redesign - Performance & Isolation
--
-- Purpose:
-- --   1. Harden version isolation with dataset_version_id indexes.
-- 3.   2. Add composite indexes for large-scale report generation.
-- 4.   3. Add dataset_hash for duplicate detection (Phase 8).
-- ============================================================================

-- ---- manual_gl_staged_transactions -----------------------------------------

-- Phase 6: Strict Version Isolation
-- Accelerates queryStagingTransactions when filtering by dataset_version_id.
CREATE INDEX IF NOT EXISTS idx_gl_company_version_id
  ON manual_gl_staged_transactions(company_id, dataset_version_id)
  WHERE dataset_version_id IS NOT NULL;

-- Phase 5: Report Generation Performance
-- Optimizes the common pattern of grouping by account/category within a batch/year slice.
CREATE INDEX IF NOT EXISTS idx_gl_report_building_composite
  ON manual_gl_staged_transactions(company_id, upload_batch_id, fiscal_year, account_name);

-- ---- manual_gl_batches -----------------------------------------------------

-- Phase 8: Dataset Hashing
-- Allows fast lookup of existing datasets to prevent duplicate uploads.
ALTER TABLE manual_gl_batches 
  ADD COLUMN IF NOT EXISTS dataset_hash TEXT,
  ADD COLUMN IF NOT EXISTS row_count INTEGER,
  ADD COLUMN IF NOT EXISTS total_debit DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS total_credit DECIMAL(18,2);

CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_dataset_hash
  ON manual_gl_batches(company_id, dataset_hash);

-- ---- upload_jobs -----------------------------------------------------------

-- Phase 4: Job Progress Tracking
-- Add columns for better job visibility if they don't exist.
ALTER TABLE upload_jobs
  ADD COLUMN IF NOT EXISTS dataset_hash TEXT,
  ADD COLUMN IF NOT EXISTS dataset_version_id UUID REFERENCES dataset_versions(id);

CREATE INDEX IF NOT EXISTS idx_upload_jobs_company_status 
  ON upload_jobs(company_id, status);
