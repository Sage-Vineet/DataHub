-- The bank reconciliation's editable rows — adjustments and add-back items.
--
-- These two tables exist in the deployed database but in NO source this repo
-- applies. `backend/sql/schema.sql` does not create them; `tools/demo/up.sh`
-- applies only migrations 049 and 050 from the legacy set, and the migrations
-- that create these are 047 and 048 — under numbers legacy reused three times
-- over (three 047s, three 048s, two 049s), which is how they came to be skipped.
--
-- So the schema snapshot this repo builds its tests from has never had them,
-- while the running demo does. Written here rather than by adding more legacy
-- migrations to the chain: the schema is ours now, and one place should say
-- what these tables are.
--
-- IF NOT EXISTS throughout, because the deployed database already has them and
-- this must be applicable to it as well as to an empty one.

CREATE TABLE IF NOT EXISTS bank_reconciliation_adjustments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The grid's column and row, as it labels them: "2024-03" and "deposits".
  month      text NOT NULL,
  row_key    text NOT NULL,
  amount     numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The grid saves on blur, so the same cell is written over and over. This is
-- what makes that an upsert rather than a hundred rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_recon_adjustment
  ON bank_reconciliation_adjustments(company_id, month, row_key);

CREATE INDEX IF NOT EXISTS idx_bank_recon_adj_company
  ON bank_reconciliation_adjustments(company_id, month);

CREATE TABLE IF NOT EXISTS bank_reconciliation_addback_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The two halves of the reconciliation. Constrained rather than free text:
  -- a row filed under anything else renders nowhere and is invisible until
  -- somebody notices the totals do not add up.
  section       text NOT NULL CHECK (section IN ('deposits', 'withdrawals')),
  name          text NOT NULL,
  -- manual | derived — whether somebody typed this line or it was computed.
  source        text NOT NULL DEFAULT 'manual',
  -- month → amount, as the grid renders it.
  month_amounts jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Which reconciliation this line belongs to. Without it every source's rows
  -- come back together and a manual reconciliation shows QuickBooks lines.
  report_source text NOT NULL DEFAULT 'quickbooks_online',
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brai_company_source_section
  ON bank_reconciliation_addback_items(company_id, report_source, section);
