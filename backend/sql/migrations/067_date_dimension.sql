-- ============================================================================
-- Migration 067: key_report_date_dimension (client Excel spec)
--
-- Purpose:
--   Create a reusable date_dimension table matching the client's spec exactly:
--   id, date, year, month, quarter, month_name — NO fiscal_year/fiscal_month/
--   fiscal_quarter/week_number/weekday/month_end/year_end. (fiscal_year and
--   fiscal_month already live on general_ledger_entries itself, as plain
--   columns — they are NOT duplicated here.)
--
--   general_ledger_entries.date_id is additive; transaction_date is KEPT for
--   backward compatibility with every existing reader.
--
--   Named key_report_date_dimension (not date_dimension) to avoid collision
--   with the existing date_dimension table in this Supabase project, which
--   has a different schema and purpose.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS key_report_date_dimension (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date        date NOT NULL,
  year        integer NOT NULL,
  month       integer NOT NULL,       -- 1-12
  quarter     integer NOT NULL,       -- 1-4
  month_name  text NOT NULL,          -- 'January' … 'December'
  CONSTRAINT uq_key_report_date_dimension_date UNIQUE (date)
);

CREATE INDEX IF NOT EXISTS idx_key_report_date_dimension_year_month
  ON key_report_date_dimension(year, month);

-- Backfill one row per DISTINCT transaction_date already in the GL (generic,
-- no company/version hardcoding; safe to re-run).
INSERT INTO key_report_date_dimension (date, year, month, quarter, month_name)
SELECT DISTINCT
  transaction_date,
  EXTRACT(YEAR FROM transaction_date)::int,
  EXTRACT(MONTH FROM transaction_date)::int,
  EXTRACT(QUARTER FROM transaction_date)::int,
  to_char(transaction_date, 'FMMonth')
FROM general_ledger_entries
WHERE transaction_date IS NOT NULL
ON CONFLICT (date) DO NOTHING;

ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS date_id uuid REFERENCES key_report_date_dimension(id) ON DELETE SET NULL;

UPDATE general_ledger_entries gl
   SET date_id = dd.id
  FROM key_report_date_dimension dd
 WHERE gl.transaction_date = dd.date
   AND gl.date_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_gl_entries_date_id
  ON general_ledger_entries(version_id, date_id);

COMMENT ON TABLE key_report_date_dimension IS
  'Calendar date dimension (client Excel spec): id, date, year, month, quarter, month_name only — no fiscal columns.';
COMMENT ON COLUMN general_ledger_entries.date_id IS
  'FK to key_report_date_dimension.id. Additive — transaction_date is kept for backward compatibility.';
