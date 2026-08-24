-- Give the two reconciliation tables a company they belong to.
--
-- `bank_transactions` and `reconciliation_transactions` both exist and both
-- carry `client_id uuid` — NULLABLE, with no foreign key and no cascade. Three
-- consequences, all silent:
--
--   A row with a null company belongs to nobody. It is written, it is never
--   read by any page, and nothing ever says so. A reconciliation missing it
--   simply reports a difference that is not there.
--
--   A row with a company id that does not exist is the same thing with extra
--   steps: it looks attributed and reaches no page.
--
--   Deleting a company leaves both sets of rows behind forever. They are that
--   company's bank statement lines and ledger transactions — exactly the data
--   a deletion is meant to remove.
--
-- Rows that cannot be attributed are removed rather than left: an orphan here
-- is a transaction nobody can see and nobody can reconcile, and keeping it
-- means the constraint cannot be added at all.

DELETE FROM bank_transactions
 WHERE client_id IS NULL
    OR client_id NOT IN (SELECT id FROM companies);

DELETE FROM reconciliation_transactions
 WHERE client_id IS NULL
    OR client_id NOT IN (SELECT id FROM companies);

ALTER TABLE bank_transactions
  ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE bank_transactions
  DROP CONSTRAINT IF EXISTS bank_transactions_client_id_fkey;
ALTER TABLE bank_transactions
  ADD CONSTRAINT bank_transactions_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE reconciliation_transactions
  ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE reconciliation_transactions
  DROP CONSTRAINT IF EXISTS reconciliation_transactions_client_id_fkey;
ALTER TABLE reconciliation_transactions
  ADD CONSTRAINT reconciliation_transactions_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES companies(id) ON DELETE CASCADE;

-- "Every transaction for this company, in date order" is the only read either
-- table gets, and it is the whole table per company. The existing index is on
-- `client_id` alone, so the sort happens every time.
CREATE INDEX IF NOT EXISTS idx_bank_transactions_client_date
  ON bank_transactions(client_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_reconciliation_transactions_client_date
  ON reconciliation_transactions(client_id, txn_date);
