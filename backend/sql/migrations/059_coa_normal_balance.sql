-- ============================================================================
-- Migration 059: Add normal_balance column to chart_of_accounts
--
-- Purpose (client workbook + request):
--   Add a `normal_balance` column to the `chart_of_accounts` table to track
--   whether the normal balance of an account is debit or credit.
--
-- Seed:
--   Populate existing accounts based on account_type:
--     asset | expense | cogs          => debit
--     liability | equity | revenue | income => credit
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS normal_balance text;

-- Seed existing leaves
UPDATE chart_of_accounts
  SET normal_balance = 'debit'
  WHERE account_type IN ('asset', 'expense', 'cogs')
    AND normal_balance IS NULL;

UPDATE chart_of_accounts
  SET normal_balance = 'credit'
  WHERE account_type IN ('liability', 'equity', 'revenue', 'income')
    AND normal_balance IS NULL;

-- Default fallback
UPDATE chart_of_accounts
  SET normal_balance = 'debit'
  WHERE normal_balance IS NULL;

COMMENT ON COLUMN chart_of_accounts.normal_balance IS
  'Normal balance of the account (debit | credit).';
