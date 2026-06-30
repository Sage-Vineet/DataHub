-- ============================================================================
-- Migration 060: Refactor general_ledger_entries to match the client's
--               accounting workflow (Data Table WF 06.16.2026)
--
-- Purpose:
--   Transform general_ledger_entries from a raw QuickBooks export mirror into
--   a proper accounting ledger that serves as the single source of truth for
--   all financial reports.
--
-- Column changes:
--   RENAME distribution_account → account_name   (primary posting account)
--   RENAME transaction_num      → transaction_number
--   RENAME memo_description     → memo
--   RENAME debit                → debit_amount
--   RENAME credit               → credit_amount
--
--   ADD    fiscal_month  integer  (1-12, derived from transaction_date)
--   ADD    coa_id        uuid FK  (links each GL row to chart_of_accounts)
--
--   DROP   net_amount          (generated column, depends on debit/credit)
--   DROP   description, reference, category, sub_category, department,
--          class, location, journal_type, vendor_name, transaction_hash,
--          account_type, transaction_name
--
-- Idempotent: safe to re-run (every step guarded with IF EXISTS / DO blocks).
-- Hand-apply via the Supabase SQL editor.
-- ============================================================================

-- ── 1. Drop the generated column that depends on debit/credit ─────────────────
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS net_amount;

-- ── 2-4. Rename distribution_account → account_name ─────────────────────────
--   Three cases handled:
--     A) Both account_name (legacy NOT NULL) AND distribution_account exist
--        → coalesce then three-step swap
--     B) Only distribution_account exists (no legacy account_name column)
--        → direct rename
--     C) account_name already exists, distribution_account already gone
--        → no-op (already migrated)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'general_ledger_entries' AND column_name = 'account_name'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'general_ledger_entries' AND column_name = 'distribution_account'
  ) THEN
    -- Case A: both columns present — coalesce into distribution_account then swap
    ALTER TABLE general_ledger_entries ALTER COLUMN account_name DROP NOT NULL;
    UPDATE general_ledger_entries
       SET distribution_account = account_name
     WHERE distribution_account IS NULL
       AND account_name IS NOT NULL
       AND account_name <> '';
    ALTER TABLE general_ledger_entries RENAME COLUMN account_name TO _legacy_account_name;
    ALTER TABLE general_ledger_entries RENAME COLUMN distribution_account TO account_name;
    ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS _legacy_account_name;

  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'general_ledger_entries' AND column_name = 'distribution_account'
  ) THEN
    -- Case B: only distribution_account exists — direct rename
    ALTER TABLE general_ledger_entries RENAME COLUMN distribution_account TO account_name;

  ELSE
    -- Case C: account_name already correct and distribution_account gone
    RAISE NOTICE 'account_name already in correct state — skipping rename';
  END IF;
END $$;

-- ── 5. Rename transaction_num → transaction_number ───────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'general_ledger_entries' AND column_name = 'transaction_num'
  ) THEN
    ALTER TABLE general_ledger_entries RENAME COLUMN transaction_num TO transaction_number;
  END IF;
END $$;

-- ── 6. Rename memo_description → memo ────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'general_ledger_entries' AND column_name = 'memo_description'
  ) THEN
    ALTER TABLE general_ledger_entries RENAME COLUMN memo_description TO memo;
  END IF;
END $$;

-- ── 7. Rename debit → debit_amount (or add if missing entirely) ──────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'general_ledger_entries' AND column_name = 'debit'
  ) THEN
    ALTER TABLE general_ledger_entries RENAME COLUMN debit TO debit_amount;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'general_ledger_entries' AND column_name = 'debit_amount'
  ) THEN
    ALTER TABLE general_ledger_entries ADD COLUMN debit_amount numeric(15,2) DEFAULT 0;
  END IF;
END $$;

-- ── 7b. Rename credit → credit_amount (or add if missing entirely) ───────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'general_ledger_entries' AND column_name = 'credit'
  ) THEN
    ALTER TABLE general_ledger_entries RENAME COLUMN credit TO credit_amount;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'general_ledger_entries' AND column_name = 'credit_amount'
  ) THEN
    ALTER TABLE general_ledger_entries ADD COLUMN credit_amount numeric(15,2) DEFAULT 0;
  END IF;
END $$;

-- ── 8. Add fiscal_month (1–12) ────────────────────────────────────────────────
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS fiscal_month integer;

UPDATE general_ledger_entries
   SET fiscal_month = EXTRACT(MONTH FROM transaction_date)::integer
 WHERE transaction_date IS NOT NULL
   AND fiscal_month IS NULL;

-- ── 9. Add coa_id (nullable FK — populated after COA generation) ──────────────
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS coa_id uuid
    REFERENCES chart_of_accounts(id) ON DELETE SET NULL;

-- ── 9b. Ensure all required columns exist (add if missing) ───────────────────
--   These columns may be absent if the table was created before later
--   extraction-service versions added them.
ALTER TABLE general_ledger_entries ADD COLUMN IF NOT EXISTS row_type        text;
ALTER TABLE general_ledger_entries ADD COLUMN IF NOT EXISTS row_number      integer;
ALTER TABLE general_ledger_entries ADD COLUMN IF NOT EXISTS account_section text;
ALTER TABLE general_ledger_entries ADD COLUMN IF NOT EXISTS account_number  text;
ALTER TABLE general_ledger_entries ADD COLUMN IF NOT EXISTS transaction_type text;
ALTER TABLE general_ledger_entries ADD COLUMN IF NOT EXISTS split_account   text;
ALTER TABLE general_ledger_entries ADD COLUMN IF NOT EXISTS amount          numeric(15,2);
ALTER TABLE general_ledger_entries ADD COLUMN IF NOT EXISTS running_balance numeric(15,2);
ALTER TABLE general_ledger_entries ADD COLUMN IF NOT EXISTS raw_row_json    jsonb;
ALTER TABLE general_ledger_entries ADD COLUMN IF NOT EXISTS memo            text;
ALTER TABLE general_ledger_entries ADD COLUMN IF NOT EXISTS transaction_number text;

-- ── 10. Drop legacy migration-049 columns that are not in the new schema ─────
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS description;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS reference;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS category;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS sub_category;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS department;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS class;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS location;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS journal_type;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS vendor_name;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS transaction_hash;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS account_type;
ALTER TABLE general_ledger_entries DROP COLUMN IF EXISTS transaction_name;

-- ── 11. Supporting indexes for new columns ────────────────────────────────────

-- Fast month-level GL aggregation (Monthly BS engine, Trial Balance).
CREATE INDEX IF NOT EXISTS idx_gl_entries_fiscal_month
  ON general_ledger_entries(version_id, fiscal_year, fiscal_month);

-- COA linkage lookup.
CREATE INDEX IF NOT EXISTS idx_gl_entries_coa_id
  ON general_ledger_entries(version_id, coa_id)
  WHERE coa_id IS NOT NULL;

-- account_name search (replaces the old distribution_account index).
CREATE INDEX IF NOT EXISTS idx_gl_entries_account_name
  ON general_ledger_entries(version_id, account_name);

-- Drop the obsolete distribution_account index if it exists.
DROP INDEX IF EXISTS idx_general_ledger_entries_section;

-- Column comments omitted intentionally — add individually if all columns are
-- confirmed present, since COMMENT ON fails if the column does not exist.
