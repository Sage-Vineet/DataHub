-- ============================================================================
-- Migration 048: Workspace Page State
--
-- Purpose:
-- Store lightweight per-company workspace UI state, scoped by page key. The
-- application currently scopes page keys by user before persistence.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workspace_page_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  page_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_workspace_page_state_company_page UNIQUE (company_id, page_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_page_state_company
  ON workspace_page_state(company_id, updated_at DESC);

