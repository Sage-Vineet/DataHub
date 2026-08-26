-- ============================================================================
-- Migration 054: Generated Report Persistence
--
-- Purpose:
--   Allow balance_sheet_entries and profit_loss_entries to store rows that
--   were GENERATED (via GL carry-forward) rather than directly extracted from
--   an uploaded file.
--
--   Changes:
--     1. Add is_generated boolean column (DEFAULT false) to both tables.
--        Extracted rows keep is_generated = false (unchanged).
--        Generated rows (GL carry-forward) are stored with is_generated = true.
--     2. Drop the NOT NULL constraint on source_file_id for both tables.
--        Generated rows have no linked document; uploaded rows still carry their
--        document FK.  The FK itself (ON DELETE RESTRICT) is kept so existing
--        uploaded rows remain protected.
--
-- Why source_file_id is made nullable (not removed):
--   - Extraction rows still carry source_file_id for audit / delete-on-resync.
--   - Generated rows have source_file_id = NULL — they do not belong to any
--     uploaded file, so making the column nullable is the minimal correct change.
--
-- When generated rows are deleted:
--   - keyReportSyncService.js deletes all is_generated rows at the START of every
--     sync so the carry-forward is recomputed from freshly extracted data.
--
-- This migration is idempotent: safe to re-run.
-- ============================================================================

-- ── balance_sheet_entries ─────────────────────────────────────────────────────

ALTER TABLE balance_sheet_entries
  ADD COLUMN IF NOT EXISTS is_generated boolean NOT NULL DEFAULT false;

ALTER TABLE balance_sheet_entries
  ALTER COLUMN source_file_id DROP NOT NULL;

-- Index: generated-row queries (used when checking whether to skip regeneration)
CREATE INDEX IF NOT EXISTS idx_balance_sheet_entries_generated
  ON balance_sheet_entries(version_id, fiscal_year, is_generated)
  WHERE is_generated = true;

-- ── profit_loss_entries ────────────────────────────────────────────────────────

ALTER TABLE profit_loss_entries
  ADD COLUMN IF NOT EXISTS is_generated boolean NOT NULL DEFAULT false;

ALTER TABLE profit_loss_entries
  ALTER COLUMN source_file_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profit_loss_entries_generated
  ON profit_loss_entries(version_id, fiscal_year, is_generated)
  WHERE is_generated = true;

-- ── Comments ──────────────────────────────────────────────────────────────────

COMMENT ON COLUMN balance_sheet_entries.is_generated IS
  'true = row was generated from GL carry-forward (not extracted from an uploaded file)';
COMMENT ON COLUMN profit_loss_entries.is_generated IS
  'true = row was generated from GL transactions (not extracted from an uploaded file)';
