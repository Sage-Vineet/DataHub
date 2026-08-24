-- Reverse of 0017.
--
-- Narrowing REFUSES on a database holding a cached customer or invoice list,
-- because Postgres validates a new CHECK against existing rows. Those lists
-- have to be cleared before rolling back, which is the honest requirement —
-- silently keeping them would leave a constraint that lies about its table.

ALTER TABLE statement_extracts
  DROP CONSTRAINT IF EXISTS statement_extracts_type_check;

ALTER TABLE statement_extracts
  ADD CONSTRAINT statement_extracts_type_check CHECK (statement_type IN (
    'balance_sheet', 'profit_and_loss', 'cash_flow', 'bank_reconciliation',
    'tax_return', 'general_ledger', 'account_list'
  ));
