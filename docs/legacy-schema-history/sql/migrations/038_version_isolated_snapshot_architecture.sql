-- ============================================================================
-- Migration 038: Version-Isolated Snapshot Architecture
--
-- Purpose:
--   Enforce hard dataset-version isolation for reporting_snapshots so that
--   every snapshot row is unambiguously owned by exactly one upload version.
--
-- Key changes:
--   1. Ensure dataset_version (integer) is always populated on new snapshots.
--   2. Back-fill dataset_version on any existing rows that have it NULL.
--   3. Add a composite unique constraint scoped to (company_id, dataset_version,
--      report_type, fiscal_year) so getSnapshotForDatasetVersion always
--      resolves to the right row without falling back to the active batch.
--   4. Add indexes that cover both version-based and batch-based snapshot reads.
--   5. Guard manual_gl_staged_transactions against accidental cross-version
--      reads by ensuring upload_batch_id and dataset_version_id indexes exist.
-- ============================================================================

-- ── 1. Back-fill dataset_version from the linked batch row ───────────────────
UPDATE reporting_snapshots s
SET dataset_version = b.dataset_version
FROM manual_gl_batches b
WHERE b.id = s.upload_batch_id
  AND s.dataset_version IS NULL
  AND b.dataset_version IS NOT NULL;

-- ── 2. Composite unique constraint: version × report_type × fiscal_year ──────
-- This is the constraint that getSnapshotForDatasetVersion relies on.
-- It allows multiple fiscal-year slices per version (one row per year) but
-- prevents two snapshot rows from claiming the same version × type × year slot.
-- NULL dataset_version rows are not covered (old snapshots) — each NULL is
-- distinct in PostgreSQL, so they will never collide with versioned rows.

CREATE UNIQUE INDEX IF NOT EXISTS uq_reporting_snapshots_version_type_year
  ON reporting_snapshots(company_id, dataset_version, report_type, fiscal_year)
  WHERE dataset_version IS NOT NULL;

-- ── 3. Performance indexes for common read patterns ──────────────────────────

-- Used by getSnapshotForDatasetVersion (primary versioned lookup path):
CREATE INDEX IF NOT EXISTS idx_reporting_snapshots_version_lookup
  ON reporting_snapshots(company_id, dataset_version, report_type, fiscal_year, generated_at DESC)
  WHERE dataset_version IS NOT NULL;

-- Used by getSnapshotForBatch (batch-level fallback, active-batch reads):
CREATE INDEX IF NOT EXISTS idx_reporting_snapshots_batch_lookup
  ON reporting_snapshots(company_id, upload_batch_id, report_type, fiscal_year, generated_at DESC);

-- ── 4. Ensure staged-transaction isolation columns are indexed ───────────────
--    (Migration 030 already adds these; the IF NOT EXISTS guards are idempotent)

ALTER TABLE manual_gl_staged_transactions
  ADD COLUMN IF NOT EXISTS dataset_version_id UUID;

CREATE INDEX IF NOT EXISTS idx_staged_tx_company_batch
  ON manual_gl_staged_transactions(company_id, upload_batch_id);

CREATE INDEX IF NOT EXISTS idx_staged_tx_company_version_id
  ON manual_gl_staged_transactions(company_id, dataset_version_id)
  WHERE dataset_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staged_tx_company_batch_year
  ON manual_gl_staged_transactions(company_id, upload_batch_id, fiscal_year);

-- ── 5. Ensure balance-sheet-lines isolation columns are indexed ──────────────
ALTER TABLE manual_gl_balance_sheet_lines
  ADD COLUMN IF NOT EXISTS dataset_version_id UUID,
  ADD COLUMN IF NOT EXISTS upload_batch_id UUID REFERENCES manual_gl_batches(id);

-- Backfill upload_batch_id from batch_id for existing rows
UPDATE manual_gl_balance_sheet_lines
SET upload_batch_id = batch_id
WHERE upload_batch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_bs_lines_company_batch
  ON manual_gl_balance_sheet_lines(company_id, upload_batch_id);

CREATE INDEX IF NOT EXISTS idx_bs_lines_company_version_id
  ON manual_gl_balance_sheet_lines(company_id, dataset_version_id)
  WHERE dataset_version_id IS NOT NULL;

-- ── 6. Ensure manual_gl_batches has a fast dataset_version lookup index ──────
CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company_dv_active
  ON manual_gl_batches(company_id, dataset_version, is_active DESC, created_at DESC)
  WHERE dataset_version IS NOT NULL
    AND COALESCE(source_type, 'manual_gl_upload') = 'manual_gl_upload';
