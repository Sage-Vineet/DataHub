-- Migration: Custom CIM PowerPoint templates (Template Intelligence Engine)
-- Purpose: Persist the metadata + parsed schema for a broker-uploaded custom
--   .pptx CIM template so it survives page reloads. The uploaded binary itself
--   lives in the existing `uploads` table/Storage bucket (upload_id here just
--   references it); this table stores the per-company pointer + the parsed
--   placeholder/element schema (jsonb, no binary) produced by
--   src/lib/cimTemplateIntelligence.js's analyzeCustomPptxTemplate().
-- Date: 2026-07-13
--
-- Backward compatible: net-new table, no existing behavior is touched. The
-- default fixed-template CIM Builder workflow never reads or writes this
-- table.
--
-- NOTE: Apply via the Supabase Dashboard SQL editor.

CREATE TABLE IF NOT EXISTS cim_custom_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_size bigint,
  signature text NOT NULL,
  schema jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cim_custom_templates_company
  ON cim_custom_templates(company_id, is_active);
