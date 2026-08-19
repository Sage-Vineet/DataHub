-- QoE SDE/EBITDA bridge (QE - 0004).
--
-- Two things land here:
--   1. `chart_of_accounts.ebitda_role` — the centralized account-level flag that
--      replaces label matching when building Reported EBITDA. NULL means
--      unflagged, which contributes nothing. That is deliberate: a missing
--      add-back is visible on review, an invented one is not.
--   2. `qoe_addbacks` — the redesigned add-back record. The legacy
--      `ebitda_adjustments` set (043/045) had the right bones but no sourcing
--      kind, no data source, no grouping, no granularity and no recast
--      baseline. Existing rows are migrated across below.

ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS ebitda_role text;

-- The ledger→COA link the bridge reads.
--
-- This column already exists in the deployed UAT database (it appears in the
-- 25 Jul 2026 table dump alongside `split_coa_id`, `date_id` and `entity_type`)
-- but is declared by NO migration in this repository — the deployed schema has
-- drifted ahead of the migration set. Declaring it here reconciles the two; the
-- IF NOT EXISTS makes that a no-op where it is already present.
--
-- The bridge joins on this rather than on `account_name` deliberately: account
-- names are not unique in practice (UAT issue #4 reports duplicates in the
-- chart of accounts), so a name join silently merges distinct accounts.
ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS coa_id uuid;

CREATE INDEX IF NOT EXISTS idx_gl_entries_coa
  ON general_ledger_entries (version_id, coa_id);

COMMENT ON COLUMN chart_of_accounts.ebitda_role IS
  'interest_income | interest_expense | income_tax | depreciation | amortization | owner_compensation. NULL = unflagged, contributes nothing to Reported EBITDA.';

-- One market-rate replacement salary. The ONLY structural difference between
-- Adjusted EBITDA (owner comp net of this) and SDE (full owner comp).
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS market_rate_replacement_salary numeric(18, 2);

CREATE TABLE IF NOT EXISTS qoe_addbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id text NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('pnl_account_vendor', 'balance_sheet_change', 'manual_adjustment', 'recast')),
  data_source text NOT NULL DEFAULT 'company_financials'
    CHECK (data_source IN ('company_financials', 'tax_return')),
  type_key text NOT NULL,
  name text NOT NULL,
  linked_account_id text,
  vendor_scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  granularity text NOT NULL DEFAULT 'detail'
    CHECK (granularity IN ('detail', 'smoothed')),
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  recast_normalized_value numeric(18, 2),
  group_id text,
  group_label text,
  explanation text,
  commentary text,
  qa_citation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  -- A manual adjustment is unusable as evidence without a stated reason, and a
  -- recast is meaningless without the value it is measured against. Enforced in
  -- the contract, the engine AND here, so no write path can bypass it.
  CONSTRAINT qoe_addbacks_manual_needs_explanation
    CHECK (kind <> 'manual_adjustment' OR (explanation IS NOT NULL AND btrim(explanation) <> '')),
  CONSTRAINT qoe_addbacks_recast_needs_normalized_value
    CHECK (kind <> 'recast' OR recast_normalized_value IS NOT NULL),
  CONSTRAINT qoe_addbacks_gl_sourced_needs_account
    CHECK (kind NOT IN ('pnl_account_vendor', 'recast') OR linked_account_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_qoe_addbacks_scope
  ON qoe_addbacks (company_id, version_id, deleted_at);

-- Carry existing UAT add-backs across. `kind` is derived: an adjustment with a
-- linked account came from the GL, anything else was hand-entered. Rows with no
-- explanation get a placeholder naming their origin rather than being dropped —
-- losing a reviewer's work silently would be worse than an ugly note.
--
-- Wrapped in dynamic SQL because `ebitda_adjustments` (legacy migration 043) is
-- absent in a database built from `packages/db` alone. A plain INSERT ... SELECT
-- would fail to PARSE there, which no WHERE guard can prevent.
DO $migrate$
BEGIN
  IF to_regclass('public.ebitda_adjustments') IS NULL THEN
    RAISE NOTICE 'ebitda_adjustments not present — nothing to migrate.';
    RETURN;
  END IF;

  EXECUTE $sql$
    INSERT INTO qoe_addbacks (
      id, company_id, version_id, kind, data_source, type_key, name,
      linked_account_id, vendor_scope, granularity, values,
      group_id, group_label, explanation, commentary,
      created_by, created_at, updated_at, deleted_at
    )
    SELECT
      a.id,
      a.company_id,
      a.version_id,
      CASE WHEN a.linked_account_id IS NOT NULL AND NOT a.is_manual
           THEN 'pnl_account_vendor' ELSE 'manual_adjustment' END,
      'company_financials',
      a.type_key,
      a.name,
      a.linked_account_id,
      COALESCE(a.vendor_scope, '[]'::jsonb),
      'detail',
      COALESCE(
        (SELECT jsonb_object_agg(
                  CASE WHEN v.month = 0 THEN v.year::text
                       ELSE v.year::text || '-' || lpad(v.month::text, 2, '0') END,
                  v.value)
           FROM ebitda_adjustment_values v
          WHERE v.adjustment_id = a.id),
        '{}'::jsonb),
      NULL,
      NULL,
      CASE WHEN a.linked_account_id IS NOT NULL AND NOT a.is_manual
           THEN a.supporting_explanation
           ELSE COALESCE(
                  NULLIF(btrim(COALESCE(a.supporting_explanation, a.override_reason, a.description)), ''),
                  'Migrated from ebitda_adjustments; original entry carried no explanation.')
      END,
      a.analyst_comments,
      a.created_by,
      a.created_at,
      a.updated_at,
      a.deleted_at
    FROM ebitda_adjustments a
    ON CONFLICT (id) DO NOTHING
  $sql$;
END
$migrate$;
