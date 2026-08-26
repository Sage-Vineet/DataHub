-- Migration: Manual GL multi-year normalized staging tables
-- Purpose: Support scalable multi-file GL staging, query-level filtering,
--          audit traceability, and staged-report generation.
-- Date: 2026-05-07

CREATE TABLE IF NOT EXISTS manual_gl_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual_gl',
  status text NOT NULL DEFAULT 'staged',
  batch_name text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company
  ON manual_gl_batches(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS manual_gl_staged_transactions (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES manual_gl_batches(id) ON DELETE CASCADE,
  transaction_id text NOT NULL,
  fiscal_year integer,
  txn_date date,
  account_number text,
  account_name text NOT NULL,
  account_type text,
  category text,
  sub_category text,
  debit numeric(18, 2) NOT NULL DEFAULT 0,
  credit numeric(18, 2) NOT NULL DEFAULT 0,
  net_amount numeric(18, 2) NOT NULL DEFAULT 0,
  class text,
  department text,
  location text,
  journal_type text,
  transaction_type text,
  reference text,
  description text,
  source_file text,
  source_upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  row_number integer,
  transaction_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_manual_gl_txn_hash UNIQUE (company_id, transaction_hash)
);

CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_batch
  ON manual_gl_staged_transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_company_date
  ON manual_gl_staged_transactions(company_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_company_year
  ON manual_gl_staged_transactions(company_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_account
  ON manual_gl_staged_transactions(company_id, account_name, account_number);
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_category
  ON manual_gl_staged_transactions(company_id, category, sub_category);

CREATE TABLE IF NOT EXISTS manual_gl_balance_sheet_lines (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES manual_gl_batches(id) ON DELETE CASCADE,
  sheet_type text NOT NULL, -- STARTING | ENDING
  as_of_date date,
  section text NOT NULL,    -- assets | liabilities | equity
  account_name text NOT NULL,
  amount numeric(18, 2) NOT NULL DEFAULT 0,
  source_file text,
  source_upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  row_number integer,
  line_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_manual_gl_bs_line_hash UNIQUE (company_id, batch_id, sheet_type, line_hash)
);

CREATE INDEX IF NOT EXISTS idx_manual_gl_bs_batch
  ON manual_gl_balance_sheet_lines(batch_id, sheet_type);
CREATE INDEX IF NOT EXISTS idx_manual_gl_bs_company_date
  ON manual_gl_balance_sheet_lines(company_id, as_of_date);
