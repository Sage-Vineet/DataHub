-- ============================================================================
-- Migration 034: Production-Grade Performance Optimization Indexes
--
-- Purpose: Close the remaining index gaps identified in the May 2026 audit:
--   1. reporting_snapshots — fast company-level report reads without batch_id
--   2. manual_gl_batches   — fast status/active-batch lookups during orchestration
--   3. manual_gl_upload_sessions — fast active-session and version-number lookups
--   4. manual_gl_staged_transactions — txn_date range queries and month-filter support
--
-- These complement migrations 032 and 033 which covered the transaction-level
-- batch+year composites and the session hash-uniqueness constraint.
-- ============================================================================

-- ---- reporting_snapshots ---------------------------------------------------

-- Covers the most common read path:
--   SELECT * FROM reporting_snapshots
--   WHERE company_id = $1 AND report_type = $2 AND fiscal_year = $3
--   ORDER BY generated_at DESC LIMIT 1
-- Used by every report-render endpoint that falls back from snapshot to live calc.
CREATE INDEX IF NOT EXISTS idx_reporting_snapshots_company_report_year
  ON reporting_snapshots(company_id, report_type, fiscal_year, generated_at DESC);

-- Covers batch-scoped reads:
--   SELECT * FROM reporting_snapshots
--   WHERE company_id = $1 AND upload_batch_id = $2 AND report_type = $3
-- Used by getSnapshotForBatch() on every report page load.
CREATE INDEX IF NOT EXISTS idx_reporting_snapshots_company_batch_report
  ON reporting_snapshots(company_id, upload_batch_id, report_type, fiscal_year);

-- Covers dataset_version reads used by getSnapshotForDatasetVersion():
--   WHERE company_id = $1 AND dataset_version = $2 AND report_type = $3
CREATE INDEX IF NOT EXISTS idx_reporting_snapshots_company_version_report
  ON reporting_snapshots(company_id, dataset_version, report_type, fiscal_year)
  WHERE dataset_version IS NOT NULL;

-- ---- manual_gl_batches -----------------------------------------------------

-- Accelerates orchestration status queries:
--   WHERE company_id = $1 AND batch_status = $2
-- Covers: active-batch lookup, processing-lock detection, stale-lock cleanup.
CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company_status
  ON manual_gl_batches(company_id, batch_status, is_active);

-- Partial index for the single-active-batch fast path (hot path on every report load):
--   WHERE company_id = $1 AND is_active = true AND source_type = 'manual_gl_upload'
CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company_active
  ON manual_gl_batches(company_id, is_active)
  WHERE is_active = true;

-- ---- manual_gl_upload_sessions ---------------------------------------------

-- Covers replaceActiveUploadSessions SELECT per fiscal year:
--   WHERE company_id = $1 AND fiscal_year = $2 AND is_active = true
CREATE INDEX IF NOT EXISTS idx_manual_gl_upload_sessions_company_fy_active
  ON manual_gl_upload_sessions(company_id, fiscal_year, is_active)
  WHERE is_active = true;

-- Covers getLatestUploadSessionVersion():
--   WHERE company_id = $1 AND fiscal_year = $2 ORDER BY version_no DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_manual_gl_upload_sessions_company_fy_version
  ON manual_gl_upload_sessions(company_id, fiscal_year, version_no DESC);

-- Covers findExistingStagedUploadSessionsByYearHash() JOIN on staging_batch_id:
--   WHERE company_id = $1 AND fiscal_year IN (...) AND status IN ('staged','active')
CREATE INDEX IF NOT EXISTS idx_manual_gl_upload_sessions_company_fy_status
  ON manual_gl_upload_sessions(company_id, fiscal_year, status);

-- ---- manual_gl_staged_transactions — supplemental --------------------------

-- Covers month-based filter (fiscalMonths filter applied post-fetch today, but
-- an index on txn_date helps any range query that uses startDate/endDate filters):
--   WHERE company_id = $1 AND upload_batch_id = $2 AND txn_date BETWEEN $3 AND $4
CREATE INDEX IF NOT EXISTS idx_gl_company_batch_txndate
  ON manual_gl_staged_transactions(company_id, upload_batch_id, txn_date);

-- Covers vendor-level drilldown with fiscal year filter:
--   WHERE company_id = $1 AND upload_batch_id = $2 AND vendor_name = $3 AND fiscal_year = $4
CREATE INDEX IF NOT EXISTS idx_gl_company_batch_vendor_year
  ON manual_gl_staged_transactions(company_id, upload_batch_id, vendor_name, fiscal_year)
  WHERE vendor_name IS NOT NULL;
