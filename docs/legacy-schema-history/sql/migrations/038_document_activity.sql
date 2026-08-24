-- Migration: create document_activity table for tracking document views/downloads.
-- Run this in the Supabase SQL editor if the table does not already exist.

DO $$ BEGIN
  CREATE TYPE document_activity_type AS ENUM ('view', 'download');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS document_activity (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid        NOT NULL REFERENCES documents(id)  ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  activity_type text        NOT NULL CHECK (activity_type IN ('view','download')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_activity_document ON document_activity(document_id);
CREATE INDEX IF NOT EXISTS idx_document_activity_user     ON document_activity(user_id);
