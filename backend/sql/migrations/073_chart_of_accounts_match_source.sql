-- ============================================================================
-- Migration 073: chart_of_accounts.match_source
--
-- Purpose: a first-class, top-level audit column recording WHICH hierarchy
-- source resolved each generated account, distinct from metadata->>match_tier
-- (which records the finer-grained tier within a source, e.g. "exact_name"
-- vs "fuzzy" within client_coa). Requested explicitly so every hierarchy
-- decision is auditable without reaching into JSON metadata.
--
-- Values: client_coa | balance_sheet | profit_loss | generated | manual_review
--         | existing_working_coa
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS match_source text;

CREATE INDEX IF NOT EXISTS idx_coa_match_source ON chart_of_accounts (match_source);
