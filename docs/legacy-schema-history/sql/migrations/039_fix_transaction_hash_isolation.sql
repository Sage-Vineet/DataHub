-- Migration 039: Fix transaction hash isolation for multi-version GL datasets
--
-- ROOT CAUSE:
--   Migration 018 added a GLOBAL unique constraint (company_id, transaction_hash)
--   on manual_gl_staged_transactions.  This constraint spans ALL batches for a
--   company, which means the same transaction content (same account/amount/date)
--   cannot exist in two different upload batches.
--
--   This breaks multi-version staging in two ways:
--     1. insertTransactions: when the batch-scoped (company_id, batch_id,
--        transaction_hash) constraint fires its fallback it lands on the global
--        constraint — rows that already exist in Version A are silently skipped
--        (ignoreDuplicates:true) for Version B, producing incomplete staged data.
--     2. copyBatchTransactionsForYears: same fallback path; carry-forward rows
--        that hash-collide with Version A are silently dropped from Version B.
--
-- FIX:
--   Drop the global constraints.  The batch-scoped constraints (added by
--   migration 011) are the correct idempotency guard — they prevent duplicate
--   rows WITHIN a batch while allowing the same content to appear in different
--   batches (different versions).
--
--   This migration is fully idempotent.
--
-- NOTE ON EXCEPTION HANDLING:
--   PostgreSQL raises error code 42P07 ("duplicate_table") — not 42710
--   ("duplicate_object") — when ADD CONSTRAINT would create a duplicate
--   implicit index.  Using IF NOT EXISTS guards via pg_constraint avoids
--   this ambiguity entirely.

-- ── Step 1: Drop the dangerous global constraints ─────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_manual_gl_txn_hash_legacy'
      AND conrelid = 'manual_gl_staged_transactions'::regclass
  ) THEN
    ALTER TABLE manual_gl_staged_transactions
      DROP CONSTRAINT uq_manual_gl_txn_hash_legacy;
    RAISE NOTICE 'Dropped uq_manual_gl_txn_hash_legacy.';
  ELSE
    RAISE NOTICE 'Constraint uq_manual_gl_txn_hash_legacy does not exist — skipping.';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_manual_gl_bs_line_hash_legacy'
      AND conrelid = 'manual_gl_balance_sheet_lines'::regclass
  ) THEN
    ALTER TABLE manual_gl_balance_sheet_lines
      DROP CONSTRAINT uq_manual_gl_bs_line_hash_legacy;
    RAISE NOTICE 'Dropped uq_manual_gl_bs_line_hash_legacy.';
  ELSE
    RAISE NOTICE 'Constraint uq_manual_gl_bs_line_hash_legacy does not exist — skipping.';
  END IF;
END $$;

-- ── Step 2: Ensure the batch-scoped constraints exist ─────────────────────────
-- These were added by migration 011.  Re-add idempotently in case that
-- migration was not applied to this database.

-- Deduplicate staged transactions first (safe no-op if no duplicates exist).
DELETE FROM manual_gl_staged_transactions
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id, batch_id, transaction_hash) id
  FROM manual_gl_staged_transactions
  ORDER BY company_id, batch_id, transaction_hash, id DESC
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_manual_gl_txn_hash_batch'
      AND conrelid = 'manual_gl_staged_transactions'::regclass
  ) THEN
    ALTER TABLE manual_gl_staged_transactions
      ADD CONSTRAINT uq_manual_gl_txn_hash_batch
      UNIQUE (company_id, batch_id, transaction_hash);
    RAISE NOTICE 'Created uq_manual_gl_txn_hash_batch.';
  ELSE
    RAISE NOTICE 'Constraint uq_manual_gl_txn_hash_batch already exists — skipping.';
  END IF;
END $$;

-- Deduplicate balance sheet lines first (safe no-op if no duplicates exist).
DELETE FROM manual_gl_balance_sheet_lines
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id, batch_id, sheet_type, line_hash) id
  FROM manual_gl_balance_sheet_lines
  ORDER BY company_id, batch_id, sheet_type, line_hash, id DESC
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_manual_gl_bs_line_hash_batch'
      AND conrelid = 'manual_gl_balance_sheet_lines'::regclass
  ) THEN
    ALTER TABLE manual_gl_balance_sheet_lines
      ADD CONSTRAINT uq_manual_gl_bs_line_hash_batch
      UNIQUE (company_id, batch_id, sheet_type, line_hash);
    RAISE NOTICE 'Created uq_manual_gl_bs_line_hash_batch.';
  ELSE
    RAISE NOTICE 'Constraint uq_manual_gl_bs_line_hash_batch already exists — skipping.';
  END IF;
END $$;

-- ── Step 3: Reload PostgREST schema cache ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';
