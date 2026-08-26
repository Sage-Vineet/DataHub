-- Migration: Fix missing unique constraints on manual GL staging tables for legacy fallbacks
-- Purpose: Add legacy unique constraints required by ON CONFLICT fallback clauses
--          in manualGlMultiYearService.js to prevent "no unique or exclusion constraint" errors.

-- Step 1: manual_gl_staged_transactions fallback constraint
DELETE FROM manual_gl_staged_transactions
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id, transaction_hash) id
  FROM manual_gl_staged_transactions
  ORDER BY company_id, transaction_hash, id DESC
);

DO $$
BEGIN
  ALTER TABLE manual_gl_staged_transactions
    ADD CONSTRAINT uq_manual_gl_txn_hash_legacy
    UNIQUE (company_id, transaction_hash);
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;


-- Step 2: manual_gl_balance_sheet_lines fallback constraint
DELETE FROM manual_gl_balance_sheet_lines
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id, sheet_type, line_hash) id
  FROM manual_gl_balance_sheet_lines
  ORDER BY company_id, sheet_type, line_hash, id DESC
);

DO $$
BEGIN
  ALTER TABLE manual_gl_balance_sheet_lines
    ADD CONSTRAINT uq_manual_gl_bs_line_hash_legacy
    UNIQUE (company_id, sheet_type, line_hash);
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

-- Step 3: Ensure PostgREST schema cache is reloaded so Supabase recognizes the new constraints
NOTIFY pgrst, 'reload schema';
