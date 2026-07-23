-- Migration: Key Reports processing caches (performance optimization)
-- Purpose: Avoid re-doing expensive work on re-syncs and version duplication.
--   1. key_report_document_processing — caches the OUTPUT of a document's
--      extract() step (parse + Gemini/Python AI) keyed by the file's content
--      fingerprint. On an unchanged document the sync reuses this instead of
--      re-downloading, re-parsing, and re-calling the AI. Version-agnostic: the
--      raw extracted rows do not depend on the Key Report version, so a
--      duplicated/new version reuses a prior version's extraction.
--   2. key_report_coa_classification_cache — caches per-account AI classifications
--      (geminiCoaClassifier) keyed by normalized account name, so re-syncs only
--      send NEW/unseen accounts to the AI.
--
-- Both caches degrade gracefully: if this migration has not been applied the
-- services simply skip the cache (no error, current behavior preserved).
-- Date: 2026-07-03
--
-- NOTE: Apply via the Supabase Dashboard SQL editor (direct pg connections are
-- blocked from dev machines).

-- ── 1. Document extraction cache ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS key_report_document_processing (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id          uuid        NOT NULL,
  data_type            text        NOT NULL,   -- tax_return | bank_statement | balance_sheet | general_ledger | profit_loss
  document_fingerprint text        NOT NULL,   -- SHA-256 of the file binary content
  parser_version       text        NOT NULL DEFAULT 'v1',
  extraction_version   text        NOT NULL DEFAULT 'v1',
  file_name            text,
  processing_status    text        NOT NULL DEFAULT 'completed', -- pending | processing | completed | failed
  extracted_data       jsonb,      -- { rows: [...], detectedYears: [...] } — the reusable extract() output
  row_count            integer     NOT NULL DEFAULT 0,
  processing_error     text,
  processing_started_at  timestamptz,
  processing_completed_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_kr_doc_processing UNIQUE (company_id, document_id, document_fingerprint, data_type, parser_version, extraction_version)
);

CREATE INDEX IF NOT EXISTS idx_kr_doc_processing_lookup
  ON key_report_document_processing(company_id, document_id, document_fingerprint);
CREATE INDEX IF NOT EXISTS idx_kr_doc_processing_status
  ON key_report_document_processing(company_id, processing_status);

-- ── 2. COA AI classification reuse cache ────────────────────────────────────
CREATE TABLE IF NOT EXISTS key_report_coa_classification_cache (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  normalized_name    text        NOT NULL,   -- normName(accountName) — the classifier's map key
  classifier_version text        NOT NULL DEFAULT 'v1',
  classification     jsonb       NOT NULL,   -- the exact classification object the AI returned
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_kr_coa_classification UNIQUE (company_id, normalized_name, classifier_version)
);

CREATE INDEX IF NOT EXISTS idx_kr_coa_classification_lookup
  ON key_report_coa_classification_cache(company_id, classifier_version);
