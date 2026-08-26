CREATE TABLE IF NOT EXISTS ebitda_adjustment_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_key text NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ebitda_adjustment_types (type_key, label, description, sort_order, is_active)
VALUES
  ('personal_expense', 'Personal Expense', 'Expenses that are personal in nature and should be added back.', 10, true),
  ('non_recurring_charge', 'Non-recurring Charge', 'One-time or non-recurring costs that normalize earnings.', 20, true),
  ('officer_compensation', 'Officer Compensation', 'Owner/officer compensation adjustment.', 30, true),
  ('related_party_rent', 'Related Party Rent', 'Rent paid to a related party above or below market.', 40, true),
  ('other_non_market_wages', 'Other Non-Market Wages', 'Payroll or wage adjustments outside market compensation.', 50, true),
  ('prior_period_adjustment', 'Prior Period Adjustment', 'Prior period or historical corrections.', 60, true),
  ('accrual_adjustment', 'Accrual Adjustment', 'Accrual-based normalization or reversal.', 70, true),
  ('other_addback', 'Other Addback', 'Any other EBITDA normalization that does not fit a standard type.', 80, true)
ON CONFLICT (type_key) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = now();

CREATE TABLE IF NOT EXISTS ebitda_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id text NOT NULL,
  dataset_version_id uuid REFERENCES dataset_versions(id) ON DELETE SET NULL,
  upload_batch_id uuid REFERENCES manual_gl_batches(id) ON DELETE SET NULL,
  source_key text NOT NULL DEFAULT 'manual_gl',
  type_key text NOT NULL,
  name text NOT NULL,
  description text,
  linked_account_id text,
  linked_account_name text,
  vendor_scope_mode text NOT NULL DEFAULT 'entire_account',
  vendor_scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_manual boolean NOT NULL DEFAULT false,
  override_reason text,
  internal_notes text,
  analyst_comments text,
  supporting_explanation text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS ebitda_adjustment_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id text NOT NULL,
  adjustment_id uuid NOT NULL REFERENCES ebitda_adjustments(id) ON DELETE CASCADE,
  year integer NOT NULL,
  month integer NOT NULL DEFAULT 0,
  value numeric(18, 2) NOT NULL DEFAULT 0,
  original_value numeric(18, 2),
  override_value numeric(18, 2),
  override_reason text,
  source_value numeric(18, 2),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ebitda_adjustment_values UNIQUE (adjustment_id, year, month)
);

CREATE TABLE IF NOT EXISTS ebitda_adjustment_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id text NOT NULL,
  adjustment_id uuid NOT NULL REFERENCES ebitda_adjustments(id) ON DELETE CASCADE,
  upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  file_name text NOT NULL,
  file_url text NOT NULL,
  content_type text,
  size_bytes bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ebitda_adjustment_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id text NOT NULL,
  adjustment_id uuid NOT NULL REFERENCES ebitda_adjustments(id) ON DELETE CASCADE,
  comment_type text NOT NULL DEFAULT 'internal',
  body text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ebitda_adjustment_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id text NOT NULL,
  adjustment_id uuid REFERENCES ebitda_adjustments(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  before_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ebitda_adjustments_company_version
  ON ebitda_adjustments(company_id, version_id, source_key, deleted_at);
CREATE INDEX IF NOT EXISTS idx_ebitda_adjustments_account
  ON ebitda_adjustments(company_id, version_id, linked_account_id);
CREATE INDEX IF NOT EXISTS idx_ebitda_adjustments_dataset_version
  ON ebitda_adjustments(company_id, dataset_version_id);
CREATE INDEX IF NOT EXISTS idx_ebitda_adjustments_upload_batch
  ON ebitda_adjustments(company_id, upload_batch_id);

CREATE INDEX IF NOT EXISTS idx_ebitda_adjustment_values_company_version
  ON ebitda_adjustment_values(company_id, version_id, adjustment_id, year, month);
CREATE INDEX IF NOT EXISTS idx_ebitda_adjustment_values_adjustment
  ON ebitda_adjustment_values(adjustment_id, year, month);

CREATE INDEX IF NOT EXISTS idx_ebitda_adjustment_attachments_company_version
  ON ebitda_adjustment_attachments(company_id, version_id, adjustment_id);
CREATE INDEX IF NOT EXISTS idx_ebitda_adjustment_comments_company_version
  ON ebitda_adjustment_comments(company_id, version_id, adjustment_id);
CREATE INDEX IF NOT EXISTS idx_ebitda_adjustment_audit_company_version
  ON ebitda_adjustment_audit_log(company_id, version_id, adjustment_id, created_at DESC);
