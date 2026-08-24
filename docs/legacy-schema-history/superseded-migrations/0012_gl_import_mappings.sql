-- The column mapping somebody confirmed for an uploaded ledger.
--
-- REPLACES THE MAPPING HALF OF `manual_gl_upload_sessions`, WHICH IS ABSENT
-- ------------------------------------------------------------------------
-- Legacy's upload session carried three unrelated things at once: which
-- columns mean what, how far the staging got, and which import is current.
-- The second is a `sync_run` and the third is a `dataset_version`; both are
-- already tables. What is left — and genuinely belongs to the upload — is the
-- mapping.
--
-- WHY STORE IT AT ALL
-- -------------------
-- Detection is a default, and a person can correct it. Once they have, that
-- correction has to survive: re-staging a file, or importing a second year
-- from the same export, must not make them do it again — and, worse, must not
-- silently fall back to a detection that disagrees with what they chose last
-- time. A ledger imported twice under two different mappings is two different
-- sets of figures from one file.

CREATE TABLE IF NOT EXISTS gl_import_mappings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The uploaded file this mapping is for. CASCADE: a mapping for a file that
  -- is gone describes nothing.
  upload_id   uuid NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  -- field -> column name, with "" for unmapped. The field set changes as the
  -- importer learns to read more, so jsonb rather than eleven columns.
  mapping     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What detection thought, kept alongside what the person chose. Being able
  -- to see that somebody overrode a confident guess is the difference between
  -- diagnosing a bad import and staring at it.
  detected    jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One mapping per file. Re-confirming replaces; a second row would make "the
-- mapping for this upload" a question of which was found first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_import_mappings_upload
  ON gl_import_mappings(company_id, upload_id);
