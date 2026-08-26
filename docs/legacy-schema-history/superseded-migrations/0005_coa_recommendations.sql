-- Chart-of-accounts reasonableness recommendations — the advisory review layer.
--
-- Consolidates legacy `081_ai_hierarchy_recommendations.sql` and
-- `089_coa_reasonableness_recommendations.sql` from the `data_room` branch into
-- the shape they arrive at together. Replaying the evolution would be
-- dishonest: 081 created a table that could express exactly one suggestion
-- ("insert one roll-up label above this P&L account") and 089 widened it to a
-- full target hierarchy, a target type, a graded confidence and an audit trail.
-- No database in this lineage has ever held the intermediate shape, so nothing
-- is served by recreating it.
--
-- WHAT THIS TABLE IS. Suggestions, and only suggestions. No report engine reads
-- it — trial balance, balance sheet, P&L and cash flow all read
-- `chart_of_accounts` directly, exactly as they did before the feature existed.
-- A row here reaches `chart_of_accounts` only when a person accepts it, and
-- then only through the one hierarchy-writing path, which touches the level
-- columns and never a balance or a GL mapping.

BEGIN;

CREATE TABLE IF NOT EXISTS key_report_coa_hierarchy_recommendations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id                  uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  -- The legacy table left this unconstrained. Every table added since carries a
  -- real foreign key, and an advisory row outliving its company is of no use to
  -- anyone.
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id                  uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,

  -- ── The account as the reviewer saw it ────────────────────────────────────
  -- Snapshot at generation time: the non-null level values, INCLUDING the
  -- account's own name last. Its purpose is the staleness gate — comparing this
  -- against the account now is how an old proposal is stopped from silently
  -- undoing a newer edit.
  current_hierarchy           jsonb NOT NULL,
  current_account_type        text,
  current_statement_type      text,

  -- ── What is being proposed ────────────────────────────────────────────────
  --   ROLLUP_INSERT   insert one new intermediate label (the original engine)
  --   HIERARCHY_MOVE  move to a different existing section, same type
  --   RECLASSIFY      misclassified outright — carries a target type
  kind                        text NOT NULL DEFAULT 'ROLLUP_INSERT',

  -- The full target path, same shape as current_hierarchy so the two diff
  -- directly. Nullable because rows written by the original engine carry only
  -- `recommended_rollup`, and the service still renders those.
  recommended_hierarchy       jsonb,
  -- The deepest new label. Part of the uniqueness key below, which is what lets
  -- a re-run upsert onto the same row instead of duplicating it.
  recommended_rollup          text NOT NULL,
  recommended_parent          text,

  -- Populated for RECLASSIFY only. NULL means "presentation only — do not touch
  -- this account's type", which is the overwhelming majority.
  recommended_account_type    text,
  recommended_statement_type  text,

  -- ── Confidence, provenance, materiality ───────────────────────────────────
  -- The numeric score still orders the list; the band is what a reviewer reads.
  confidence                  numeric,
  confidence_band             text,
  --   DOCUMENT_MATCH     the target section exists in the client's own uploads
  --   AI_REASONABLENESS  no such section — derived, and the reviewer is told so
  source                      text,
  impact                      text,
  reason                      text,
  ai_model                    text,

  -- ── Decision trail ────────────────────────────────────────────────────────
  status                      text NOT NULL DEFAULT 'pending',
  rejection_reason            text,
  decided_at                  timestamptz,
  decided_by                  uuid,
  applied_at                  timestamptz,
  -- What was actually written, recorded independently of what was recommended,
  -- so an audit never has to re-derive it.
  applied_hierarchy           jsonb,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- One recommendation per (account, suggested rollup) per version. This is the
  -- conflict target the upsert relies on; without it a second pass duplicates
  -- every row instead of refreshing it.
  UNIQUE (version_id, account_id, recommended_rollup)
);

-- `accepted` and `ignored` are the original engine's vocabulary and are kept
-- rather than normalised away. No row in this database has them yet, but the
-- service still maps them (accepted -> APPLIED, ignored -> REJECTED) so that
-- decided rows imported from the legacy deployment stay valid and are never
-- silently rewritten. A migration that dropped them would turn somebody's
-- recorded decision into a constraint violation.
ALTER TABLE key_report_coa_hierarchy_recommendations
  DROP CONSTRAINT IF EXISTS coa_reco_status_check;
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD CONSTRAINT coa_reco_status_check
  CHECK (status IN ('pending', 'applied', 'rejected', 'accepted', 'ignored'));

ALTER TABLE key_report_coa_hierarchy_recommendations
  DROP CONSTRAINT IF EXISTS coa_reco_kind_check;
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD CONSTRAINT coa_reco_kind_check
  CHECK (kind IN ('ROLLUP_INSERT', 'HIERARCHY_MOVE', 'RECLASSIFY'));

-- The enum-ish columns are constrained only where a value is present, so a row
-- carrying none of them stays valid.
ALTER TABLE key_report_coa_hierarchy_recommendations
  DROP CONSTRAINT IF EXISTS coa_reco_confidence_band_check;
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD CONSTRAINT coa_reco_confidence_band_check
  CHECK (confidence_band IS NULL OR confidence_band IN ('HIGH', 'MEDIUM', 'LOW'));

ALTER TABLE key_report_coa_hierarchy_recommendations
  DROP CONSTRAINT IF EXISTS coa_reco_source_check;
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD CONSTRAINT coa_reco_source_check
  CHECK (source IS NULL OR source IN ('DOCUMENT_MATCH', 'AI_REASONABLENESS'));

ALTER TABLE key_report_coa_hierarchy_recommendations
  DROP CONSTRAINT IF EXISTS coa_reco_impact_check;
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD CONSTRAINT coa_reco_impact_check
  CHECK (impact IS NULL OR impact IN (
    'CLASSIFICATION', 'PRESENTATION', 'BALANCE_SHEET_SECTION', 'OPERATING_RESULT'));

-- A RECLASSIFY is the only kind allowed to carry a target type, and it must
-- carry one. The service already refuses to store a RECLASSIFY without a valid
-- type — never downgrading it to a hierarchy move, which would apply a P&L path
-- to a balance-sheet account — and this is the same rule where it cannot be
-- bypassed by a future writer.
ALTER TABLE key_report_coa_hierarchy_recommendations
  DROP CONSTRAINT IF EXISTS coa_reco_reclassify_type_check;
--
-- The `IS NOT NULL` is load-bearing, not belt-and-braces. `NULL IN (...)`
-- evaluates to NULL rather than FALSE, and a CHECK constraint rejects only on
-- FALSE — so without it a RECLASSIFY carrying no type at all satisfies the
-- constraint by being unknown, which is precisely the row this exists to stop.
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD CONSTRAINT coa_reco_reclassify_type_check
  CHECK (
    (kind = 'RECLASSIFY'
       AND recommended_account_type IS NOT NULL
       AND recommended_account_type IN
         ('income', 'cogs', 'expense', 'asset', 'liability', 'equity'))
    OR (kind <> 'RECLASSIFY' AND recommended_account_type IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_coa_reco_version
  ON key_report_coa_hierarchy_recommendations(version_id);
CREATE INDEX IF NOT EXISTS idx_coa_reco_status
  ON key_report_coa_hierarchy_recommendations(version_id, status);
CREATE INDEX IF NOT EXISTS idx_coa_reco_band
  ON key_report_coa_hierarchy_recommendations(version_id, confidence_band);
CREATE INDEX IF NOT EXISTS idx_coa_reco_account
  ON key_report_coa_hierarchy_recommendations(account_id);

COMMIT;
