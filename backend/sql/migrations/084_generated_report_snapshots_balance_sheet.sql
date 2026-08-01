-- Widens generated_report_snapshots.report_type to also allow 'balance_sheet'.
--
-- Migration 061 restricted this table to 'profit_loss' / 'cash_flow' only —
-- Balance Sheet was always recomputed fresh from balance_sheet_entries + GL on
-- every request (via financialStatementService.generateFinancialStatements),
-- with no persisted, sync-time-materialized snapshot of its own. This widens
-- the CHECK constraint so Balance Sheet can be persisted through the exact
-- same snapshot mechanism P&L and Cash Flow already use — same table, same
-- (version_id, report_type, scope_key) shape, no new table, no schema change
-- beyond the allowed value list.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.

ALTER TABLE generated_report_snapshots
  DROP CONSTRAINT IF EXISTS generated_report_snapshots_report_type_check;

ALTER TABLE generated_report_snapshots
  ADD CONSTRAINT generated_report_snapshots_report_type_check
  CHECK (report_type IN ('profit_loss', 'cash_flow', 'balance_sheet'));
