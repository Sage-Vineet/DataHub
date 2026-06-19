CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'broker', 'buyer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE company_status AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE request_category AS ENUM ('Finance', 'Legal', 'Compliance', 'HR', 'Tax', 'M&A', 'Other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE response_type AS ENUM ('Upload', 'Narrative', 'Both');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE request_priority AS ENUM ('high', 'medium', 'low', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE request_status AS ENUM ('pending', 'in-review', 'completed', 'blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_status AS ENUM ('verified', 'under-review', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE reminder_status AS ENUM ('active', 'done');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE activity_type AS ENUM ('upload', 'request', 'approved', 'reminder');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_activity_type AS ENUM ('view', 'download');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  industry text NOT NULL,
  status company_status NOT NULL DEFAULT 'active',
  since date,
  logo text,
  contact_name text NOT NULL,
  contact_email text NOT NULL,
  contact_phone text NOT NULL,
  data_source_type text,
  quickbooks_connected boolean NOT NULL DEFAULT false,
  manual_upload_active boolean NOT NULL DEFAULT false,
  profit_metric text NOT NULL DEFAULT 'adjusted_ebitda',
  last_source_switch_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text,
  password_hash text NOT NULL,
  role user_role NOT NULL,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  status user_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_companies (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);

CREATE TABLE IF NOT EXISTS buyer_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buyer_group_members (
  group_id uuid NOT NULL REFERENCES buyer_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title text NOT NULL,
  sub_label text,
  description text NOT NULL,
  category request_category NOT NULL,
  response_type response_type NOT NULL,
  priority request_priority NOT NULL,
  status request_status NOT NULL,
  due_date date NOT NULL,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  visible boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reminder_frequency_days integer NOT NULL DEFAULT 2,
  submission_source text NOT NULL DEFAULT 'broker',
  approval_status text NOT NULL DEFAULT 'approved',
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES folders(id) ON DELETE SET NULL,
  name text NOT NULL,
  color text,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  data bytea NOT NULL,
  prefix text,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  name text NOT NULL,
  file_url text NOT NULL,
  upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  size text NOT NULL,
  ext text NOT NULL,
  status document_status NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS request_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  visible boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS request_narratives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  content text NOT NULL,
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS request_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  sent_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS folder_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES buyer_groups(id) ON DELETE CASCADE,
  can_read boolean NOT NULL DEFAULT true,
  can_write boolean NOT NULL DEFAULT false,
  can_download boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folder_access_subject CHECK (
    (user_id IS NOT NULL AND group_id IS NULL) OR
    (user_id IS NULL AND group_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  request_id uuid REFERENCES requests(id) ON DELETE CASCADE,
  title text NOT NULL,
  message text,
  due_date date NOT NULL,
  priority text NOT NULL DEFAULT 'medium',
  frequency_days integer NOT NULL DEFAULT 2,
  sent_count integer NOT NULL DEFAULT 0,
  last_sent_at timestamptz,
  next_due_at timestamptz,
  status reminder_status NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type activity_type NOT NULL,
  message text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_type document_activity_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id bigserial PRIMARY KEY,
  txn_date date NOT NULL,
  narration text,
  amount numeric(14, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_transactions (
  id bigserial PRIMARY KEY,
  txn_date date NOT NULL,
  client_id uuid,
  amount numeric(14, 2) NOT NULL,
  name text,
  transaction_type text
);

CREATE INDEX IF NOT EXISTS idx_requests_company_id ON requests(company_id);
CREATE INDEX IF NOT EXISTS idx_user_companies_user ON user_companies(user_id);
CREATE INDEX IF NOT EXISTS idx_user_companies_company ON user_companies(company_id);
CREATE INDEX IF NOT EXISTS idx_documents_folder_id ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_upload_id ON documents(upload_id);
CREATE INDEX IF NOT EXISTS idx_folders_company_parent ON folders(company_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_folder_access_folder ON folder_access(folder_id);
CREATE INDEX IF NOT EXISTS idx_folder_access_user ON folder_access(user_id);
CREATE INDEX IF NOT EXISTS idx_folder_access_group ON folder_access(group_id);
CREATE INDEX IF NOT EXISTS idx_activity_company ON activity_log(company_id);
CREATE INDEX IF NOT EXISTS idx_reminders_company ON reminders(company_id);


CREATE INDEX IF NOT EXISTS idx_bank_transactions_client_id ON bank_transactions(client_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_transactions_client_id ON reconciliation_transactions(client_id);
CREATE INDEX IF NOT EXISTS idx_company_messages_company_created ON company_messages(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_messages_sender ON company_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_direct_messages_company_created ON direct_messages(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_direct_messages_sender_company ON direct_messages(sender_id, company_id);
CREATE INDEX IF NOT EXISTS idx_direct_messages_recipient_company ON direct_messages(recipient_id, company_id);
CREATE INDEX IF NOT EXISTS idx_document_activity_document ON document_activity(document_id);

-- Manual GL normalized multi-year staging tables
CREATE TABLE IF NOT EXISTS manual_gl_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual_gl',
  source_type text NOT NULL DEFAULT 'manual_gl_upload',
  source_switch_version timestamptz NOT NULL DEFAULT now(),
  upload_session_id uuid DEFAULT gen_random_uuid(),
  staged_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'staged',
  batch_name text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_gl_staged_transactions (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES manual_gl_batches(id) ON DELETE CASCADE,
  transaction_id text NOT NULL,
  fiscal_year integer,
  txn_date date,
  account_number text,
  account_name text NOT NULL,
  account_type text,
  category text,
  sub_category text,
  debit numeric(18, 2) NOT NULL DEFAULT 0,
  credit numeric(18, 2) NOT NULL DEFAULT 0,
  net_amount numeric(18, 2) NOT NULL DEFAULT 0,
  class text,
  department text,
  location text,
  journal_type text,
  transaction_type text,
  reference text,
  description text,
  source_file text,
  source_upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  row_number integer,
  transaction_hash text NOT NULL,
  source_type text NOT NULL DEFAULT 'manual_gl_upload',
  source_switch_version timestamptz,
  upload_session_id uuid,
  staged_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_manual_gl_txn_hash_batch UNIQUE (company_id, batch_id, transaction_hash),
  CONSTRAINT uq_manual_gl_txn_hash_legacy UNIQUE (company_id, transaction_hash)
);

CREATE TABLE IF NOT EXISTS manual_gl_balance_sheet_lines (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES manual_gl_batches(id) ON DELETE CASCADE,
  sheet_type text NOT NULL,
  as_of_date date,
  section text NOT NULL,
  account_name text NOT NULL,
  amount numeric(18, 2) NOT NULL DEFAULT 0,
  source_file text,
  source_upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  row_number integer,
  line_hash text NOT NULL,
  source_type text NOT NULL DEFAULT 'manual_gl_upload',
  source_switch_version timestamptz,
  upload_session_id uuid,
  staged_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_manual_gl_bs_line_hash_batch UNIQUE (company_id, batch_id, sheet_type, line_hash),
  CONSTRAINT uq_manual_gl_bs_line_hash_legacy UNIQUE (company_id, sheet_type, line_hash)
);

CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company
  ON manual_gl_batches(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_company_status_created
  ON manual_gl_batches(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_gl_batches_source_isolation
  ON manual_gl_batches(company_id, source_type, source_switch_version, upload_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_batch
  ON manual_gl_staged_transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_company_date
  ON manual_gl_staged_transactions(company_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_company_year
  ON manual_gl_staged_transactions(company_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_account
  ON manual_gl_staged_transactions(company_id, account_name, account_number);
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_category
  ON manual_gl_staged_transactions(company_id, category, sub_category);
CREATE INDEX IF NOT EXISTS idx_manual_gl_txn_source_isolation
  ON manual_gl_staged_transactions(company_id, source_type, source_switch_version, upload_session_id, staged_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_gl_bs_batch
  ON manual_gl_balance_sheet_lines(batch_id, sheet_type);
CREATE INDEX IF NOT EXISTS idx_manual_gl_bs_company_date
  ON manual_gl_balance_sheet_lines(company_id, as_of_date);
CREATE INDEX IF NOT EXISTS idx_manual_gl_bs_source_isolation
  ON manual_gl_balance_sheet_lines(company_id, source_type, source_switch_version, upload_session_id, staged_at DESC);

-- Report source records: one row per (company, source_key); tracks selection, availability, and connection state
CREATE TABLE IF NOT EXISTS report_source_records (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_key    text        NOT NULL,
  source_label  text        NOT NULL DEFAULT '',
  is_selected   boolean     NOT NULL DEFAULT false,
  is_available  boolean     NOT NULL DEFAULT false,
  is_connected  boolean     NOT NULL DEFAULT false,
  last_connected_at timestamptz,
  last_synced_at    timestamptz,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_report_source_records_company_source UNIQUE (company_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_report_source_records_company
  ON report_source_records(company_id, source_key);

CREATE INDEX IF NOT EXISTS idx_report_source_records_selected
  ON report_source_records(company_id, is_selected);

-- EBITDA addback / adjustment engine
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

-- ============================================================================
-- Key Reports (migration 046) — official user-curated source of truth
-- ============================================================================

CREATE TABLE IF NOT EXISTS key_report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  version_name text,
  status text NOT NULL DEFAULT 'draft',
  is_active boolean NOT NULL DEFAULT false,
  resolved_batch_id uuid REFERENCES manual_gl_batches(id) ON DELETE SET NULL,
  resolved_dataset_version integer,
  last_synced_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_key_report_versions_company_number UNIQUE (company_id, version_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_key_report_versions_company_active
  ON key_report_versions(company_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_key_report_versions_company
  ON key_report_versions(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS key_report_file_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report_category text NOT NULL,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  file_name text,
  linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_key_report_file_mappings_unique
    UNIQUE (version_id, report_category, document_id)
);

CREATE INDEX IF NOT EXISTS idx_key_report_file_mappings_version
  ON key_report_file_mappings(version_id, report_category);
CREATE INDEX IF NOT EXISTS idx_key_report_file_mappings_document
  ON key_report_file_mappings(document_id);

CREATE TABLE IF NOT EXISTS key_report_sync_logs (
  id bigserial PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES key_report_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sync_status text NOT NULL DEFAULT 'started',
  sync_started_at timestamptz NOT NULL DEFAULT now(),
  sync_completed_at timestamptz,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_key_report_sync_logs_version
  ON key_report_sync_logs(version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_key_report_sync_logs_company
  ON key_report_sync_logs(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS file_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  linked_module text NOT NULL,
  linked_entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_file_references_unique
    UNIQUE (document_id, linked_module, linked_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_file_references_document
  ON file_references(document_id);
CREATE INDEX IF NOT EXISTS idx_file_references_module_entity
  ON file_references(linked_module, linked_entity_id);
CREATE INDEX IF NOT EXISTS idx_file_references_company
  ON file_references(company_id);

CREATE TABLE IF NOT EXISTS user_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pref_key text NOT NULL,
  pref_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_preferences_user_key UNIQUE (user_id, pref_key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user
  ON user_preferences(user_id);
