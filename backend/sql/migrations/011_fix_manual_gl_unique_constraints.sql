-- Migration: Fix missing unique constraints on manual GL staging tables
-- Purpose: Safely ensure the unique constraints required by ON CONFLICT clauses
--          in manualGlMultiYearService.js exist in the database.
-- Date: 2026-05-20

-- Step 1: manual_gl_staged_transactions
-- Deduplicate rows, keeping the most recently updated
DELETE FROM manual_gl_staged_transactions
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id, batch_id, transaction_hash) id
  FROM manual_gl_staged_transactions
  ORDER BY company_id, batch_id, transaction_hash, id DESC
);

-- Add constraint idempotently
DO $$
BEGIN
  ALTER TABLE manual_gl_staged_transactions
    ADD CONSTRAINT uq_manual_gl_txn_hash_batch
    UNIQUE (company_id, batch_id, transaction_hash);
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

-- Step 2: manual_gl_balance_sheet_lines
-- Deduplicate rows
DELETE FROM manual_gl_balance_sheet_lines
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id, batch_id, sheet_type, line_hash) id
  FROM manual_gl_balance_sheet_lines
  ORDER BY company_id, batch_id, sheet_type, line_hash, id DESC
);

-- Add constraint idempotently
DO $$
BEGIN
  ALTER TABLE manual_gl_balance_sheet_lines
    ADD CONSTRAINT uq_manual_gl_bs_line_hash_batch
    UNIQUE (company_id, batch_id, sheet_type, line_hash);
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;
