-- Persist rendered financial-report payloads without introducing report-specific
-- accounting tables. Source-of-truth data remains GL + COA + monthly BS.
CREATE TABLE IF NOT EXISTS generated_report_snapshots (
  id bigserial PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report_type text NOT NULL CHECK (report_type IN ('profit_loss', 'cash_flow')),
  scope_key text NOT NULL,
  payload jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_generated_report_snapshot UNIQUE (version_id, report_type, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_generated_report_snapshots_lookup
  ON generated_report_snapshots(version_id, report_type, scope_key);

COMMENT ON TABLE generated_report_snapshots IS
  'Render-ready P&L and cash-flow snapshots generated during sync. Not an accounting source table.';
