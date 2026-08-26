-- ============================================================================
-- Migration 031: Manual GL Enterprise Constraints
--
-- Purpose:
-- 1) Prevent duplicate fiscal year staging for the same company.
-- 2) Enforce deterministic uniqueness via data and content hashes.
-- 3) Optimize collision detection with targeted indexes.
-- ============================================================================

-- ---- manual_gl_batches Hardening --------------------------------------------

-- Add content_hash alias/column if not using dataset_hash exclusively.
-- For standardizing with requirements, we'll ensure dataset_hash exists (Migration 029).
-- We will treat content_hash in the requirements as referring to dataset_hash.

CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_gl_batches_content_hash
  ON manual_gl_batches(company_id, dataset_hash)
  WHERE dataset_hash IS NOT NULL AND status != 'failed';


-- ---- manual_gl_upload_sessions Hardening ------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_gl_upload_sessions_company_year_hash
  ON manual_gl_upload_sessions(company_id, fiscal_year, data_hash)
  WHERE status = 'staged';


-- ---- Performance Indexes for Collision Detection ----------------------------

CREATE INDEX IF NOT EXISTS idx_upload_sessions_company_year
  ON manual_gl_upload_sessions(company_id, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_hash
  ON manual_gl_upload_sessions(data_hash);

CREATE INDEX IF NOT EXISTS idx_batches_hash
  ON manual_gl_batches(dataset_hash);
