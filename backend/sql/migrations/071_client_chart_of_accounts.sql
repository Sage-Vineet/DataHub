-- Migration 071: client_chart_of_accounts — the imported client COA workbook,
-- the master hierarchy reference for the COA Mapping Service.
--
-- This is NOT a per-company/per-version table like chart_of_accounts. It is a
-- single, global, curated reference imported once from the client's own COA
-- workbook (chart_of_accounts_SEC.xlsx) and never modified by AI, keyword
-- rules, or regeneration — only by re-running the importer against a newer
-- version of the same source workbook. chart_of_accounts (per-version,
-- generated) copies its hierarchy FROM this table via coaMappingService; it
-- never writes back to it.
--
-- HAND-APPLY: run this migration manually against the database, consistent
-- with every other migration in this project.

CREATE TABLE IF NOT EXISTS client_chart_of_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Columns below mirror the workbook's own header exactly (see
  -- clientCoaImportService.js) — nothing here is computed except
  -- normal_balance, which has no column in the source workbook at all (see
  -- that service's docblock for why deriving it is not hierarchy invention).
  system_id text,
  account_number text,
  account_name text NOT NULL,
  account_id_name text,
  statement_type text,
  level_1 text, level_2 text, level_3 text, level_4 text, level_5 text,
  level_6 text, level_7 text, level_8 text, level_9 text, level_10 text,
  level_11 text, level_12 text, level_13 text, level_14 text, level_15 text,
  hierarchy_path text,
  classification_method text,
  adjusted_hierarchy text,
  adjusted_name text,
  -- No normal_balance column in the source workbook, and there is no
  -- account_type column here either (the workbook doesn't have one) — both
  -- stay null on import. chartOfAccountsService already derives normal_balance
  -- from Gemini's own accountType via normalBalanceFor() when a matched row
  -- doesn't supply one; deriving it here would mean inferring it from
  -- hierarchy_path text, which is exactly the kind of inference this table
  -- exists to avoid.
  normal_balance text,

  -- Traceability back to the source file, not used for matching.
  source_row_number integer,
  source_file_name text,
  imported_at timestamptz NOT NULL DEFAULT now(),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_coa_account_name ON client_chart_of_accounts (lower(account_name));
CREATE INDEX IF NOT EXISTS idx_client_coa_account_number ON client_chart_of_accounts (account_number) WHERE account_number IS NOT NULL;

-- Traceability from a generated (per-version) account back to the master row
-- it was copied from, when matched. Nullable — an unmatched (needs_mapping)
-- or standard-rule-derived account has no client_account_id.
ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS client_account_id uuid REFERENCES client_chart_of_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_client_account_id
  ON chart_of_accounts (client_account_id) WHERE client_account_id IS NOT NULL;
