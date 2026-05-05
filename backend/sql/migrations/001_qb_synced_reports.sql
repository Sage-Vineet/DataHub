-- Migration: QuickBooks Synced Reports & Soft-Disconnect
-- Purpose: Store QB financial data in DB for fallback when disconnected
-- Date: 2026-04-28

-- 1. Add is_connected flag to quickbooks_connections (soft disconnect)
ALTER TABLE quickbooks_connections
  ADD COLUMN IF NOT EXISTS is_connected boolean NOT NULL DEFAULT true;

-- 2. Create the qb_synced_reports table
CREATE TABLE IF NOT EXISTS qb_synced_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report_type text NOT NULL,            -- 'profit_and_loss', 'balance_sheet', 'cash_flow', 'profit_and_loss_detail', 'balance_sheet_detail', etc.
  report_params jsonb DEFAULT '{}'::jsonb, -- query params used (start_date, end_date, accounting_method)
  data jsonb NOT NULL,                  -- the full QB API response payload
  source text NOT NULL DEFAULT 'quickbooks',
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Unique constraint: one row per company + report_type + params combo
  CONSTRAINT uq_qb_synced_report UNIQUE (company_id, report_type, report_params)
);

-- 3. Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_qb_synced_reports_company ON qb_synced_reports(company_id);
CREATE INDEX IF NOT EXISTS idx_qb_synced_reports_type ON qb_synced_reports(company_id, report_type);
CREATE INDEX IF NOT EXISTS idx_qb_synced_reports_synced ON qb_synced_reports(last_synced_at DESC);
