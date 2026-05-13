ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_folders_company_parent_active
  ON folders(company_id, parent_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_folder_active
  ON documents(folder_id)
  WHERE archived_at IS NULL;
