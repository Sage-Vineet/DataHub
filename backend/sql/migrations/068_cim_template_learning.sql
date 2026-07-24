-- Migration: CIM Template Learning Engine mappings
-- Purpose: Replace the client-side-only (localStorage) "learning" store in
--   src/lib/cimTemplateIntelligence.js with a backend-shared table, so an
--   approved placeholder->metric mapping (keyed by a context signature hash)
--   helps every broker/device the next time a similar custom template is
--   uploaded, not just the browser that approved it. company_id NULL rows are
--   the "global" tier; company_id-scoped rows take priority over global ones
--   when both match the same context_signature (mirrors the existing
--   learning.company / learning.global two-tier lookup order).
-- Date: 2026-07-13
--
-- Backward compatible: net-new table, no existing behavior is touched. The
-- default fixed-template CIM Builder workflow never reads or writes this
-- table.
--
-- NOTE: Apply via the Supabase Dashboard SQL editor.

CREATE TABLE IF NOT EXISTS cim_template_learning_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  context_signature text NOT NULL,
  semantic_meaning text,
  metric_key text,
  expected_data_type text,
  selected_data_source text,
  confidence numeric NOT NULL DEFAULT 0.8,
  formatting_rules jsonb NOT NULL DEFAULT '[]',
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cim_template_learning_company_sig
  ON cim_template_learning_mappings ((COALESCE(company_id::text, 'global')), context_signature);
