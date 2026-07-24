-- ============================================================================
-- Migration 074: chart_of_accounts.hierarchy_confidence
--
-- Purpose: a numeric score (0-1) reflecting how strongly the SELECTED
-- HIERARCHY is supported by document evidence — distinct from ai_confidence
-- (metadata->>ai_confidence), which reflects Gemini's confidence in the
-- account_type/normalized_name recognition only. An account can have low AI
-- confidence but a high hierarchy_confidence (e.g. an exact client_coa name
-- match overriding an uncertain AI guess), or vice versa.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS hierarchy_confidence numeric;
