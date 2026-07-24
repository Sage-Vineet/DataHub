-- ============================================================================
-- Migration 056: Drop profit_loss_entries
--
-- Purpose (client request, 6/15 + 6/25 emails + Data Table WF):
--   "There should not be any P&L table ... We do not need a P&L table at all,
--    as the GL data is what will be needed to populate the P&L and other data."
--
--   Profit & Loss is now generated ENTIRELY from general_ledger_entries during
--   sync and persisted only as a render snapshot. A linked P&L document may still be used as a temporary,
--   display-only fallback (extracted on demand, never persisted).
--
-- PREREQUISITES: the application code that read/wrote profit_loss_entries has
--   already been repointed to the General Ledger (chartOfAccountsService.js,
--   financialStatementService.js, keyReportReportService.js, keyReportSyncService.js,
--   keyReportService.js), so this DROP is safe.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

DROP TABLE IF EXISTS profit_loss_entries CASCADE;
