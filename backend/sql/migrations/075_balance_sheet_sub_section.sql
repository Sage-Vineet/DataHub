-- ============================================================================
-- Migration 075: balance_sheet_entries.sub_section
--
-- Purpose: a second, additive section-qualifier column (current | fixed |
-- long_term | other) capturing the document's OWN sub-header distinction
-- (e.g. "Current Assets" vs "Fixed Assets", "Current Liabilities" vs
-- "Long-Term Liabilities") — read the same way `section` already is (from a
-- real bare header line, never guessed from an account's own name).
--
-- Deliberately a NEW column rather than changing what `section` itself means:
-- keyReportAccountingService.js and keyReportReportService.js do exact-string
-- checks against section === "assets"/"liabilities"/"equity" for real Balance
-- Sheet / Cash Flow generation logic — overloading section's values would
-- have broken those. sub_section is purely additive and only consumed by
-- chartOfAccountsService's hierarchy builder.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

ALTER TABLE balance_sheet_entries
  ADD COLUMN IF NOT EXISTS sub_section text;
