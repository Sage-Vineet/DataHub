-- Migration: Per-version addback isolation for Key Reports bank reconciliation
-- Purpose: Bank Reconciliation Activity Review addbacks were scoped only by
--   (company_id, report_source). In Key Reports mode every version of a company
--   shared the same manual_upload addbacks. This adds an optional
--   key_report_version_id so each Key Report Version (per company) keeps its own
--   addbacks. NULL = the 4 connection modes (unchanged behavior).
-- Date: 2026-07-03
--
-- Backward compatible: existing rows get key_report_version_id = NULL and remain
-- visible in the non-Key-Reports connection modes. The backend degrades
-- gracefully if this migration has not been applied yet.
--
-- NOTE: Apply via the Supabase Dashboard SQL editor.

ALTER TABLE bank_reconciliation_addback_items
  ADD COLUMN IF NOT EXISTS key_report_version_id uuid;

CREATE INDEX IF NOT EXISTS idx_bank_recon_addback_kr_version
  ON bank_reconciliation_addback_items(company_id, report_source, key_report_version_id);
