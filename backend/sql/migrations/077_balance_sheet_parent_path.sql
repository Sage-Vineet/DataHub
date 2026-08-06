-- ============================================================================
-- Migration 077: balance_sheet_entries.parent_path
--
-- Purpose: the real, arbitrary-depth ancestor chain read from the uploaded
-- document's OWN indentation (e.g. ["Assets", "Current Assets", "Bank
-- Accounts"] for a "Checking" row nested three levels deep) — never a fixed
-- or hardcoded level scheme. Populated by balanceSheetExtractionService.js's
-- indent/parent-stack tracking (Excel) and by the Gemini PDF path's nested
-- `children` tree (flattenGeminiRows), both bumped to a new parserVersion so
-- previously-extracted rows (which lack this column) get re-extracted.
--
-- Deliberately additive: `section`/`sub_section`/`hierarchy_level` (0/1) are
-- unchanged and still consumed exactly as before by every existing caller.
-- parent_path is only consumed by chartOfAccountsService's new document-
-- hierarchy classification priority (Priority 2, between the uploaded Chart
-- of Accounts match and the AI fallback).
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

ALTER TABLE balance_sheet_entries
  ADD COLUMN IF NOT EXISTS parent_path text[];
