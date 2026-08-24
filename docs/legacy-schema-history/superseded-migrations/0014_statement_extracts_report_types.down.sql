-- Reverse of 0014.
--
-- Narrowing the CHECK does not delete the rows it now forbids — Postgres
-- validates a new constraint against existing rows and REFUSES to add it if
-- any violate. So this fails loudly on a database that holds a general ledger
-- or an account list, rather than silently accepting a table the constraint
-- does not actually describe.
--
-- That is the wanted behaviour. Rolling back past this means those rows have
-- to go somewhere first, and a migration that quietly left them in place would
-- leave a CHECK that lies about its own table.

ALTER TABLE statement_extracts
  DROP CONSTRAINT IF EXISTS statement_extracts_type_check;

ALTER TABLE statement_extracts
  ADD CONSTRAINT statement_extracts_type_check CHECK (statement_type IN (
    'balance_sheet', 'profit_and_loss', 'cash_flow', 'bank_reconciliation', 'tax_return'
  ));
