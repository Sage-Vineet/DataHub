-- AI Reasonableness Check — extends the EXISTING advisory recommendation
-- table (081_ai_hierarchy_recommendations.sql) rather than creating a second
-- one. Everything already true of that table stays true:
--
--   * Nothing here is ever read by report generation. Trial Balance / Balance
--     Sheet / P&L / Cash Flow all read chart_of_accounts directly.
--   * A recommendation only ever reaches chart_of_accounts when a user
--     explicitly accepts it, and only through the existing
--     chartOfAccountsService.updateAccountHierarchy() path.
--   * The deterministic COA generation/classification/hierarchy engine is
--     untouched and remains the source of truth.
--
-- What changes: the original engine could express exactly ONE kind of
-- suggestion — "insert one roll-up label above this P&L account". The
-- reasonableness check needs to express a full target hierarchy (and, for a
-- genuinely misclassified account, a target type), across Balance Sheet as
-- well as P&L, with a graded confidence, a provenance, and an auditable
-- accept/reject trail.
--
-- Every column below is ADDITIVE and nullable, so rows written by the old
-- engine keep working and previously accepted/ignored decisions are
-- preserved. Idempotent: safe to re-run. Hand-apply via the Supabase SQL
-- editor.

-- ── The full recommended hierarchy, not just one inserted label ─────────────
-- level_1..level_N (non-null only, INCLUDING the account's own name last) —
-- exactly the same shape as current_hierarchy, so the two can be diffed
-- directly for display and for staleness detection.
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS recommended_hierarchy jsonb;

-- ── What KIND of change is being proposed ──────────────────────────────────
--   ROLLUP_INSERT  insert one new intermediate label (the original engine)
--   HIERARCHY_MOVE move the account to a different existing section, same type
--   RECLASSIFY     the account looks misclassified outright (e.g. a Balance
--                  Sheet account sitting in the P&L) — carries a target type
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'ROLLUP_INSERT';

-- Target classification, populated for RECLASSIFY only. NULL means "hierarchy
-- presentation only — do not touch this account's type", which is the case
-- for the overwhelming majority of recommendations.
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS recommended_account_type text;
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS recommended_statement_type text;

-- Snapshot of the classification at generation time, so a reviewer sees what
-- the AI actually saw and a stale recommendation can be detected.
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS current_account_type text;
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS current_statement_type text;

-- ── Graded confidence ──────────────────────────────────────────────────────
-- The numeric `confidence` column is kept (existing rows rely on it, and it
-- still orders the list); this is the banded form the reviewer actually sees.
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS confidence_band text;

-- ── Provenance ─────────────────────────────────────────────────────────────
--   DOCUMENT_MATCH      the target section exists in the client's own uploaded
--                       P&L / Balance Sheet structure
--   AI_REASONABLENESS   no such section in the document; the AI derived a
--                       logical placement and the reviewer must be told so
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS source text;

-- Which statement/area a change would move the numbers in — used to surface
-- only material recommendations rather than hundreds of observations.
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS impact text;

-- ── Audit trail ────────────────────────────────────────────────────────────
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS applied_at timestamptz;
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS ai_model text;
-- The hierarchy actually written when the recommendation was applied — the
-- applied result is recorded independently of what was recommended, so an
-- audit never has to re-derive it.
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD COLUMN IF NOT EXISTS applied_hierarchy jsonb;

-- ── Status ─────────────────────────────────────────────────────────────────
-- Widened from ('pending','accepted','ignored') to add 'rejected' and
-- 'applied'. The two legacy values are RETAINED so existing decided rows stay
-- valid and are never silently rewritten:
--   pending   awaiting review
--   applied   accepted by a user AND written to chart_of_accounts
--   rejected  declined by a user (optionally with a reason)
--   accepted  legacy: accepted by the original engine (equivalent to applied)
--   ignored   legacy: declined via the original engine (equivalent to rejected)
ALTER TABLE key_report_coa_hierarchy_recommendations
  DROP CONSTRAINT IF EXISTS key_report_coa_hierarchy_recommendations_status_check;
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD CONSTRAINT key_report_coa_hierarchy_recommendations_status_check
  CHECK (status IN ('pending', 'accepted', 'ignored', 'rejected', 'applied'));

-- Constrain the new enums only where a value is present, so legacy rows
-- (which have NULL for all of these) remain valid.
ALTER TABLE key_report_coa_hierarchy_recommendations
  DROP CONSTRAINT IF EXISTS coa_reco_kind_check;
ALTER TABLE key_report_coa_hierarchy_recommendations
  ADD CONSTRAINT coa_reco_kind_check
  CHECK (kind IN ('ROLLUP_INSERT', 'HIERARCHY_MOVE', 'RECLASSIFY'));

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

-- Backfill a band for rows written by the original engine so the upgraded UI
-- can group them alongside new ones. Thresholds match the summary buckets the
-- original service already logged (>=0.85 high, >=0.70 medium).
UPDATE key_report_coa_hierarchy_recommendations
   SET confidence_band = CASE
         WHEN confidence >= 0.85 THEN 'HIGH'
         WHEN confidence >= 0.70 THEN 'MEDIUM'
         ELSE 'LOW'
       END
 WHERE confidence_band IS NULL
   AND confidence IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_coa_hier_reco_band
  ON key_report_coa_hierarchy_recommendations(version_id, confidence_band);
