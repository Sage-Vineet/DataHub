-- ============================================================================
-- Migration 049: Key Reports Entry Tables
--
-- Purpose:
--   Create dedicated entry tables for Key Reports financial data extraction.
--   These replace dependency on manual_gl_staged_transactions for storing
--   extracted data, establishing Key Reports as the single source of truth.
--
-- Tables Created:
--   1. profit_loss_entries - P&L data from linked Excel files
--   2. balance_sheet_entries - Balance sheet data from linked Excel files
--   3. general_ledger_entries - GL transactions from linked Excel files
--   4. tax_return_entries - Tax return data extracted via Gemini
--   5. bank_statement_entries - Bank statement data from PDFs/Excel
--
-- Key Design Principles:
--   - Every row has company_id + version_id (strict isolation)
--   - Every row references source_file_id (audit trail)
--   - All are ON DELETE CASCADE when version is deleted
--   - Indexes optimized for typical query patterns
--   - No triggers or complex constraints (simplicity)
--
-- This migration is idempotent: safe to re-run.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- Table 1: profit_loss_entries
-- Stores all P&L line items from linked P&L Excel files
-- ============================================================================

CREATE TABLE IF NOT EXISTS profit_loss_entries (
  id bigserial PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_file_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,

  fiscal_year integer NOT NULL,
  account_name text NOT NULL,
  account_number text,
  account_type text,
  category text,
  sub_category text,

  amount numeric(18, 2) NOT NULL DEFAULT 0,

  hierarchy_level integer DEFAULT 0,
  parent_account_id text,
  sort_order integer DEFAULT 0,

  is_total boolean DEFAULT false,

  row_hash text,

  extracted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profit_loss_entries_version_year
  ON profit_loss_entries(version_id, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_profit_loss_entries_company
  ON profit_loss_entries(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_profit_loss_entries_source
  ON profit_loss_entries(source_file_id);

CREATE INDEX IF NOT EXISTS idx_profit_loss_entries_account
  ON profit_loss_entries(version_id, account_name, account_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profit_loss_entries_hash
  ON profit_loss_entries(version_id, source_file_id, row_hash)
  WHERE row_hash IS NOT NULL;

-- ============================================================================
-- Table 2: balance_sheet_entries
-- Stores all balance sheet line items from linked Excel files
-- ============================================================================

CREATE TABLE IF NOT EXISTS balance_sheet_entries (
  id bigserial PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_file_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,

  as_of_date date NOT NULL,
  fiscal_year integer NOT NULL,

  account_name text NOT NULL,
  account_number text,
  account_type text,
  section text,

  amount numeric(18, 2) NOT NULL DEFAULT 0,

  hierarchy_level integer DEFAULT 0,
  parent_account_id text,
  sort_order integer DEFAULT 0,

  is_total boolean DEFAULT false,

  row_hash text,

  extracted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_balance_sheet_entries_version_year
  ON balance_sheet_entries(version_id, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_balance_sheet_entries_company
  ON balance_sheet_entries(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_balance_sheet_entries_source
  ON balance_sheet_entries(source_file_id);

CREATE INDEX IF NOT EXISTS idx_balance_sheet_entries_date
  ON balance_sheet_entries(version_id, as_of_date);

CREATE INDEX IF NOT EXISTS idx_balance_sheet_entries_account
  ON balance_sheet_entries(version_id, account_name, account_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_sheet_entries_hash
  ON balance_sheet_entries(version_id, source_file_id, row_hash)
  WHERE row_hash IS NOT NULL;

-- ============================================================================
-- Table 3: general_ledger_entries
-- Stores all GL transactions from linked GL Excel files
-- Purpose: Key Reports owns GL data independently from manual_gl_staged_transactions
-- ============================================================================

CREATE TABLE IF NOT EXISTS general_ledger_entries (
  id bigserial PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_file_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,

  transaction_date date NOT NULL,
  fiscal_year integer NOT NULL,

  account_number text NOT NULL,
  account_name text NOT NULL,
  account_type text,

  description text,
  reference text,

  debit numeric(18, 2) DEFAULT 0,
  credit numeric(18, 2) DEFAULT 0,
  net_amount numeric(18, 2) GENERATED ALWAYS AS (debit - credit) STORED,

  category text,
  sub_category text,
  department text,
  class text,
  location text,
  journal_type text,
  transaction_type text,
  vendor_name text,

  row_number integer,
  transaction_hash text,

  extracted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_general_ledger_entries_version_year
  ON general_ledger_entries(version_id, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_general_ledger_entries_company
  ON general_ledger_entries(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_general_ledger_entries_source
  ON general_ledger_entries(source_file_id);

CREATE INDEX IF NOT EXISTS idx_general_ledger_entries_date
  ON general_ledger_entries(version_id, transaction_date);

CREATE INDEX IF NOT EXISTS idx_general_ledger_entries_account
  ON general_ledger_entries(version_id, account_number, account_name);

CREATE INDEX IF NOT EXISTS idx_general_ledger_entries_amount
  ON general_ledger_entries(version_id, debit, credit);

CREATE UNIQUE INDEX IF NOT EXISTS idx_general_ledger_entries_hash
  ON general_ledger_entries(version_id, source_file_id, transaction_hash)
  WHERE transaction_hash IS NOT NULL;

-- ============================================================================
-- Table 4: tax_return_entries
-- Stores extracted tax return data from linked PDF files (via Gemini)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tax_return_entries (
  id bigserial PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_file_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,

  tax_year integer NOT NULL,
  form_type text,

  field_name text NOT NULL,
  field_label text,
  field_value text,
  field_amount numeric(18, 2),

  line_number text,
  schedule text,
  section text,

  extracted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_return_entries_version_year
  ON tax_return_entries(version_id, tax_year);

CREATE INDEX IF NOT EXISTS idx_tax_return_entries_company
  ON tax_return_entries(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tax_return_entries_source
  ON tax_return_entries(source_file_id);

CREATE INDEX IF NOT EXISTS idx_tax_return_entries_field
  ON tax_return_entries(version_id, field_name);

CREATE INDEX IF NOT EXISTS idx_tax_return_entries_schedule
  ON tax_return_entries(version_id, schedule);

-- ============================================================================
-- Table 5: bank_statement_entries
-- Stores extracted bank statement transactions from linked files
-- ============================================================================

CREATE TABLE IF NOT EXISTS bank_statement_entries (
  id bigserial PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_file_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,

  statement_date date NOT NULL,
  statement_month date NOT NULL,

  bank_account text NOT NULL,
  bank_name text,
  account_type text,

  transaction_date date NOT NULL,
  description text,
  reference text,

  amount numeric(18, 2) NOT NULL DEFAULT 0,
  transaction_type text,

  running_balance numeric(18, 2),

  extracted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_statement_entries_version_month
  ON bank_statement_entries(version_id, statement_month);

CREATE INDEX IF NOT EXISTS idx_bank_statement_entries_company
  ON bank_statement_entries(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bank_statement_entries_source
  ON bank_statement_entries(source_file_id);

CREATE INDEX IF NOT EXISTS idx_bank_statement_entries_date
  ON bank_statement_entries(version_id, transaction_date);

CREATE INDEX IF NOT EXISTS idx_bank_statement_entries_account
  ON bank_statement_entries(version_id, bank_account);

-- ============================================================================
-- Add tracking columns to key_report_file_mappings (if not already present)
-- ============================================================================

ALTER TABLE IF EXISTS key_report_file_mappings
  ADD COLUMN IF NOT EXISTS extracted_rows integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extraction_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS extraction_error text,
  ADD COLUMN IF NOT EXISTS last_extracted_at timestamptz;

-- ============================================================================
-- Completion markers
-- ============================================================================

COMMENT ON TABLE profit_loss_entries IS 'Extracted P&L data from linked Excel files, version-scoped';
COMMENT ON TABLE balance_sheet_entries IS 'Extracted balance sheet data from linked Excel files, version-scoped';
COMMENT ON TABLE general_ledger_entries IS 'Extracted GL transactions from linked Excel files, version-scoped';
COMMENT ON TABLE tax_return_entries IS 'Extracted tax return data from linked PDFs, version-scoped';
COMMENT ON TABLE bank_statement_entries IS 'Extracted bank statement transactions from linked files, version-scoped';
