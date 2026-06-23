CREATE TABLE IF NOT EXISTS bank_reconciliation_adjustments (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid           NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month           text           NOT NULL,  -- YYYY-MM format, e.g. "2025-01"
  row_key         text           NOT NULL,  -- field key, e.g. "changeInAR", "depositsAddbacks"
  amount          numeric(18, 2) NOT NULL DEFAULT 0,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT uq_bank_recon_adjustment UNIQUE (company_id, month, row_key)
);

CREATE INDEX IF NOT EXISTS idx_bank_recon_adj_company
  ON bank_reconciliation_adjustments(company_id, month);
