-- Reverse of 0016.
--
-- Drops the foreign keys and makes the company optional again. It does NOT
-- bring back the orphaned rows the up-migration deleted — they were rows no
-- page could read, and nothing recorded what they had been.
--
-- Rolling back past this restores the ability to write a transaction that
-- belongs to nobody, which is the state the up-migration exists to end.

ALTER TABLE bank_transactions
  DROP CONSTRAINT IF EXISTS bank_transactions_client_id_fkey;
ALTER TABLE bank_transactions
  ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE reconciliation_transactions
  DROP CONSTRAINT IF EXISTS reconciliation_transactions_client_id_fkey;
ALTER TABLE reconciliation_transactions
  ALTER COLUMN client_id DROP NOT NULL;

DROP INDEX IF EXISTS idx_bank_transactions_client_date;
DROP INDEX IF EXISTS idx_reconciliation_transactions_client_date;
