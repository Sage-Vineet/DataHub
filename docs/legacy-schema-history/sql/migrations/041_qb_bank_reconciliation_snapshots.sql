-- Migration 041: QB Bank Reconciliation persistent snapshots
-- Stores one snapshot of QuickBooks Online bank activity per company.
-- Old snapshot is replaced (UPSERT on company_id) whenever the user refreshes.

CREATE TABLE IF NOT EXISTS qb_bank_reconciliation_snapshots (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fetched_by        uuid        REFERENCES users(id) ON DELETE SET NULL,
  accounting_method text        NOT NULL DEFAULT 'Accrual',
  start_date        date        NOT NULL,
  end_date          date        NOT NULL,
  data              jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One active snapshot per company (UPSERT target)
CREATE UNIQUE INDEX IF NOT EXISTS idx_qb_bank_recon_snapshots_company
  ON qb_bank_reconciliation_snapshots (company_id);
