-- Hand corrections to a tax reconciliation.
--
-- REPLACES A `report_type` INSIDE `qb_synced_reports`, WHICH DOES NOT EXIST
-- ------------------------------------------------------------------------
-- Legacy stored these as a single row in `qb_synced_reports` with
-- `report_type = 'tax_reconciliation_overrides'` and the whole edit history of
-- every year and every line packed into one jsonb blob:
--
--   { overrides: { "2024": { "Meals & Entertainment": { taxReturn, pl } } } }
--
-- That table is one of the thirteen this schema replaces, and this was never a
-- statement extract anyway. Every other row in `qb_synced_reports` is
-- something a machine READ out of a document. This is something a PERSON
-- TYPED, disagreeing with what the machine read. Those are opposite kinds of
-- record and the difference matters: an extract can be recomputed from its
-- source, and a correction cannot be recovered from anything at all.
--
-- WHY A ROW PER CELL RATHER THAN THE BLOB
-- ---------------------------------------
-- These are manual adjustments to figures that end up in a valuation. "Who
-- changed the 2023 meals figure, from what, and when" is the first question
-- anybody asks about a number that moved, and a single blob with one
-- `updated_at` cannot answer it for any individual cell — one edit restamps
-- the lot.
--
-- The whole-map PUT the page sends still works: it is a transactional replace
-- of that company's rows. But the storage keeps per-cell identity, so the
-- audit trail exists whether or not the API ever exposes it.

CREATE TABLE IF NOT EXISTS tax_reconciliation_overrides (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year  integer NOT NULL,
  -- The reconciling line as it reads on the return, e.g. "Meals &
  -- Entertainment". Text rather than a foreign key: these labels come off
  -- whatever the accountant actually wrote on a Schedule K, and constraining
  -- them to a list would refuse the edit somebody is trying to make.
  line_label   text NOT NULL,

  -- The two sides being reconciled. Nullable independently: an override often
  -- corrects one side and leaves the other as extracted, and a zero would read
  -- as "this line really is nil".
  tax_return_amount numeric(18,2),
  book_amount       numeric(18,2),

  -- Whether a person added this line, as opposed to correcting one extraction
  -- already found. A user-added line has no extracted counterpart, so nothing
  -- downstream should treat its absence from the return as a discrepancy.
  user_added   boolean NOT NULL DEFAULT false,

  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- A year that could not be a fiscal year is a mapping bug upstream, and
  -- letting it land makes the reconciliation silently miss the correction.
  CONSTRAINT tax_reconciliation_overrides_year_check
    CHECK (fiscal_year BETWEEN 1900 AND 2200),
  -- An empty label cannot be matched against anything on the return.
  CONSTRAINT tax_reconciliation_overrides_label_check
    CHECK (btrim(line_label) <> '')
);

-- One correction per line per year. Two rows for the same cell would leave the
-- reconciliation picking whichever came back first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_reconciliation_overrides_cell
  ON tax_reconciliation_overrides(company_id, fiscal_year, line_label);

-- "Every correction for this company", which is the only read the page makes.
CREATE INDEX IF NOT EXISTS idx_tax_reconciliation_overrides_company
  ON tax_reconciliation_overrides(company_id, fiscal_year);
