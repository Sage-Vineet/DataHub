-- ============================================================================
-- Migration 046: Key Reports Architecture
--
-- Purpose:
-- 1) Introduce "Key Reports" as the official, user-curated source of truth for
--    financial data. A Key Report VERSION holds explicit file->category mappings
--    selected from the Data Room (never auto-detected).
-- 2) Decouple the official report source from the auto-activated "latest upload"
--    behavior: key_report_versions.is_active is a SEPARATE pointer from
--    manual_gl_batches.is_active.
-- 3) Provide file-link protection via a generic file_references registry
--    (RESTRICT on document_id -- deliberately the OPPOSITE of the CASCADE used
--    everywhere else -- so a linked Data Room file cannot be silently deleted).
-- 4) Track sync runs (key_report_sync_logs) and per-user UI preferences
--    (user_preferences -- powers the first-visit educational popup).
--
-- This migration is idempotent: safe to re-run.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- Key Report versions ----------------------------------------------------
CREATE TABLE IF NOT EXISTS key_report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  version_name text,
  status text NOT NULL DEFAULT 'draft',       -- draft | synced | archived
  is_active boolean NOT NULL DEFAULT false,    -- the single OFFICIAL version per company
  -- The Manual GL batch this version's sync produced/points at (the report data).
  -- SET NULL (not CASCADE) so deleting a batch downgrades, never deletes, the version.
  resolved_batch_id uuid REFERENCES manual_gl_batches(id) ON DELETE SET NULL,
  resolved_dataset_version integer,
  last_synced_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_key_report_versions_company_number UNIQUE (company_id, version_number)
);

-- Enforce exactly one ACTIVE (official) key report version per company.
CREATE UNIQUE INDEX IF NOT EXISTS uq_key_report_versions_company_active
  ON key_report_versions(company_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_key_report_versions_company
  ON key_report_versions(company_id, created_at DESC);

-- ---- File -> category mappings ----------------------------------------------
-- A version maps each report category to one or more Data Room documents.
-- Multiple files per category are supported (no hardcoded limit).
CREATE TABLE IF NOT EXISTS key_report_file_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- profit_loss | balance_sheet | general_ledger | bank_statement | tax_return
  -- text (not enum) so categories are extensible without a migration.
  report_category text NOT NULL,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  file_name text,
  linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_key_report_file_mappings_unique
    UNIQUE (version_id, report_category, document_id)
);

CREATE INDEX IF NOT EXISTS idx_key_report_file_mappings_version
  ON key_report_file_mappings(version_id, report_category);
CREATE INDEX IF NOT EXISTS idx_key_report_file_mappings_document
  ON key_report_file_mappings(document_id);

-- ---- Sync logs (mirror existing sync_logs shape) ----------------------------
CREATE TABLE IF NOT EXISTS key_report_sync_logs (
  id bigserial PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sync_status text NOT NULL DEFAULT 'started',  -- started | success | failed
  sync_started_at timestamptz NOT NULL DEFAULT now(),
  sync_completed_at timestamptz,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_key_report_sync_logs_version
  ON key_report_sync_logs(version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_key_report_sync_logs_company
  ON key_report_sync_logs(company_id, created_at DESC);

-- ---- Generic file-reference registry (file-link protection) -----------------
-- document_id is RESTRICT on purpose: a linked Data Room file cannot be deleted
-- until it is unlinked. (Every other FK in this schema is CASCADE; this is the
-- one deliberate exception that powers deletion protection.) Application code
-- additionally returns a friendly 409 before the DB constraint would fire.
CREATE TABLE IF NOT EXISTS file_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  linked_module text NOT NULL,                 -- 'key_reports'
  linked_entity_id uuid,                       -- key_report_versions.id
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_file_references_unique
    UNIQUE (document_id, linked_module, linked_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_file_references_document
  ON file_references(document_id);
CREATE INDEX IF NOT EXISTS idx_file_references_module_entity
  ON file_references(linked_module, linked_entity_id);
CREATE INDEX IF NOT EXISTS idx_file_references_company
  ON file_references(company_id);

-- ---- Per-user UI preferences (educational popup dismissal, etc.) ------------
CREATE TABLE IF NOT EXISTS user_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pref_key text NOT NULL,                       -- e.g. 'key_reports_popup_dismissed'
  pref_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_preferences_user_key UNIQUE (user_id, pref_key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user
  ON user_preferences(user_id);
