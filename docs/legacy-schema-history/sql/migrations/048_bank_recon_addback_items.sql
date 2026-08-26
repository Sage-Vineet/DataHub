CREATE TABLE IF NOT EXISTS bank_reconciliation_addback_items (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  section       text        NOT NULL CHECK (section IN ('deposits', 'withdrawals')),
  name          text        NOT NULL,
  source        text        NOT NULL DEFAULT 'manual',
  month_amounts jsonb       NOT NULL DEFAULT '{}'::jsonb,
  sort_order    integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brai_company_section
  ON bank_reconciliation_addback_items(company_id, section);
