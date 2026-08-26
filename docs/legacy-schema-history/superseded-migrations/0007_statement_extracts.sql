-- What we read out of an uploaded financial statement.
--
-- REPLACES `qb_synced_reports`, WHICH DOES NOT EXIST
-- -------------------------------------------------
-- Legacy stored extracted statements in `qb_synced_reports`, created by
-- `backend/sql/migrations/001_qb_synced_reports.sql` — a migration nothing in
-- this repo applies. Twenty-two `/manual-report-uploads/*` routes read it, so
-- all twenty-two answer nothing today.
--
-- Two things about that table are worth not reproducing.
--
-- Its name says QuickBooks, but four sources write to it — manual GL uploads,
-- Excel and PDF uploads, and the QuickBooks-manual hybrid as well as
-- QuickBooks itself. A row here is an extract from a document, whatever put
-- the document there.
--
-- Its key was `UNIQUE (company_id, report_type, report_params)` over a jsonb
-- blob, and the code then filtered on `report_params->>'documentId'`. So the
-- real identity was always (company, document, type) with the document id
-- buried inside an opaque column that could not be indexed or read. It is a
-- column here.
--
-- WHAT A ROW MEANS
-- ----------------
-- "We read this statement out of this file." One per document per statement
-- type: a single PDF can carry a balance sheet and a P&L, and those are two
-- extracts, but re-extracting the same statement from the same file replaces
-- rather than accumulates.
--
-- `payload` stays jsonb on purpose. The shape differs per statement type and
-- per extractor, and pinning it into columns would mean a migration every time
-- extraction improves. The columns beside it are the ones something needs to
-- SEARCH by — which period, which document, how recently.

CREATE TABLE IF NOT EXISTS statement_extracts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The file it was read out of. CASCADE rather than SET NULL: an extract
  -- whose document is gone cannot be checked against anything, and keeping it
  -- would leave a statement on screen with no way to see where it came from.
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- balance_sheet | profit_and_loss | cash_flow | bank_reconciliation | tax_return
  statement_type text NOT NULL,
  -- Which upload produced the file, when there was one.
  upload_id     uuid REFERENCES uploads(id) ON DELETE SET NULL,
  -- Which report source this belongs to, so one source's extracts stay off
  -- another's page. Same vocabulary as `report_source_records.source_key`.
  source_key    text NOT NULL DEFAULT 'manual_upload_excel_pdf',

  -- The period the statement covers. A balance sheet is a moment, so it
  -- carries `as_of_date` and no start; a P&L is a span and carries both.
  -- Nullable throughout because extraction genuinely fails to find them, and a
  -- guessed period is worse than an absent one.
  period_start  date,
  period_end    date,
  as_of_date    date,
  fiscal_year   integer,

  -- The extracted statement itself.
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,

  extracted_at  timestamptz NOT NULL DEFAULT now(),
  extracted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT statement_extracts_type_check CHECK (statement_type IN (
    'balance_sheet', 'profit_and_loss', 'cash_flow', 'bank_reconciliation', 'tax_return'
  ))
);

-- The identity legacy expressed through a jsonb blob.
CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_extracts_document_type
  ON statement_extracts(company_id, document_id, statement_type);

-- "The latest balance sheet for this company on this source" — the single
-- commonest read, and the one the Reports page opens with.
CREATE INDEX IF NOT EXISTS idx_statement_extracts_latest
  ON statement_extracts(company_id, source_key, statement_type, extracted_at DESC);

-- "Everything we have for this fiscal year", for the year selector.
CREATE INDEX IF NOT EXISTS idx_statement_extracts_year
  ON statement_extracts(company_id, fiscal_year);
