-- Data room versioning, comments and chunked upload (DR - 0001), plus the deal
-- Q&A module (QA - 0001 / 0002 / 0003).
--
-- Two capabilities in one file on purpose: one file is one apply step, and apply
-- steps are where this repository's database bootstrap has historically broken.
-- They also share a foreign key — a Q&A answer files its attachment into the data
-- room — so splitting them would only mean ordering two files by hand.
--
-- Every statement is idempotent. This file may be applied to a database built
-- from backend/sql/schema.sql plus 0001, or to one already carrying part of it.
--
-- What is deliberately NOT touched here, and why:
--   * The document_status enum divergence between backend/sql/ ('verified',
--     'under-review','rejected') and packages/db/src/schema.ts ('active',
--     'processing','error'). Real, recorded in drift.ts, and orthogonal to
--     versioning — reconciling it changes behaviour on the flag-off legacy path.
--   * The document_activity column-name divergence documented at length in 0001.
--   * uploads.storage_path and file_references, which legacy declares and Drizzle
--     does not.
-- Each is a half-day with no bearing on the capabilities below.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Data room: document versions
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A version is a new row here, NOT a new `documents` row. That choice is forced
-- by how much already points at documents.id: document_activity.document_id,
-- request_documents.document_id, file_references (ON DELETE RESTRICT),
-- key_report_file_mappings, and the SPA's tree-node identity. Making a version a
-- new document would leave every one of them resolving to a stale version, and
-- would force dedup logic inside the shipped, parity-tested uploads module.
--
-- So `documents` stays the stable identity and becomes a mutable pointer to
-- whichever version is current. Restore then copies a pointer rather than bytes:
-- restoring v1 of a 200 MB file costs one row.

CREATE TABLE IF NOT EXISTS document_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no    integer NOT NULL,
  upload_id     uuid REFERENCES uploads(id) ON DELETE SET NULL,
  file_name     text NOT NULL,
  size_bytes    bigint NOT NULL DEFAULT 0,
  content_type  text,
  note          text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_document_versions_doc
  ON document_versions (document_id, version_no DESC);

-- No FK on current_version_id: it would make documents and document_versions
-- mutually dependent at create time for a guarantee the service already holds.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS current_version_id uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS version_count integer NOT NULL DEFAULT 1;

-- Backfill v1 for every document that already has content. Without this the
-- first click on version history shows an empty list, and an empty list reads as
-- a broken feature rather than a new one.
INSERT INTO document_versions (document_id, version_no, upload_id, file_name, size_bytes, created_by, created_at)
SELECT d.id, 1, d.upload_id, d.name, 0, d.uploaded_by, d.uploaded_at
FROM documents d
WHERE d.upload_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.document_id = d.id);

UPDATE documents d
SET current_version_id = v.id
FROM document_versions v
WHERE v.document_id = d.id AND v.version_no = 1 AND d.current_version_id IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- Data room: document comments
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `visibility` carries the whole access rule: 'internal' is readable only by
-- broker and admin roles, 'shared' by anyone who can read the document. One
-- toggle in the composer, one predicate in the query. Filtering happens in the
-- repository, never in the component — the client-side-only enforcement mistake
-- already exists once in this codebase (folder_access) and is not repeated here.

CREATE TABLE IF NOT EXISTS document_comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id   uuid REFERENCES document_versions(id) ON DELETE SET NULL,
  parent_id    uuid REFERENCES document_comments(id) ON DELETE CASCADE,
  body         text NOT NULL,
  visibility   text NOT NULL DEFAULT 'internal'
    CHECK (visibility IN ('internal', 'shared')),
  page_number  integer,
  author_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_document_comments_doc
  ON document_comments (document_id, created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- Data room: chunked upload
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `document_id` set on a session means "this upload is a new VERSION of that
-- document" rather than a new document — which is how a same-name re-upload
-- becomes a version without the client deciding.
--
-- Chunks are keyed by (session, index) so re-sending a chunk is an upsert. That
-- idempotency IS the resume mechanism: the client asks which indices landed and
-- sends the rest.

CREATE TABLE IF NOT EXISTS upload_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid REFERENCES companies(id) ON DELETE CASCADE,
  folder_id      uuid REFERENCES folders(id) ON DELETE CASCADE,
  document_id    uuid REFERENCES documents(id) ON DELETE CASCADE,
  file_name      text NOT NULL,
  content_type   text NOT NULL,
  total_bytes    bigint NOT NULL,
  chunk_size     integer NOT NULL,
  total_chunks   integer NOT NULL,
  received_count integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completed', 'aborted')),
  upload_id      uuid REFERENCES uploads(id) ON DELETE SET NULL,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '6 hours'
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_expiry
  ON upload_sessions (status, expires_at);

CREATE TABLE IF NOT EXISTS upload_chunks (
  session_id   uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  chunk_index  integer NOT NULL,
  size_bytes   integer NOT NULL,
  data         bytea NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, chunk_index)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Deal Q&A
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Entirely greenfield: nothing in this repository stores a question and its
-- answer as a first-class object. The need is currently served by three
-- unrelated systems — `requests` (a broker→client ask for a deliverable, with an
-- approval gate), `messages` (chat), and the CIM questionnaire (a JSON blob in
-- workspace_page_state with no per-question identity).
--
-- Status and kind columns are `text` + CHECK rather than pgEnum, deviating from
-- the style in packages/db/src/schema.ts. PGlite integration tests hand-write
-- their DDL per file, enum ALTER is awkward across that boundary, and the zod
-- contract is the real validation boundary in this architecture.

-- Categories are ROWS, not an enum, because the seller nominates answerers per
-- category per deal and an enum cannot carry a nomination. Seeded from the
-- existing request_category vocabulary so one product shows one vocabulary.
CREATE TABLE IF NOT EXISTS qa_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key         text NOT NULL,
  label       text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key)
);

-- The seller's nomination. Supplies the DEFAULT requestee at item creation;
-- QA-0001's "any deal member may reassign, and it is logged" still applies, so
-- this extends broker assignment rather than replacing it.
CREATE TABLE IF NOT EXISTS qa_nominations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES qa_categories(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nominated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  UNIQUE (category_id, user_id)
);

CREATE TABLE IF NOT EXISTS qa_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id  uuid REFERENCES qa_categories(id) ON DELETE SET NULL,
  reference    text,
  title        text NOT NULL,
  body         text NOT NULL,
  status       text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'answered', 'follow_up', 'closed')),
  priority     text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  -- QA-0003 source of origin, for downstream reporting.
  origin       text NOT NULL DEFAULT 'manual'
    CHECK (origin IN ('manual', 'qe_generator', 'cim_guided')),
  -- QA-0002 structured metadata. Defaults to 'Unclassified' rather than NULL so
  -- no item is silently dropped from the tagging pipeline.
  module_tag   text NOT NULL DEFAULT 'Unclassified',
  section_tag  text,
  account_ref  text,
  -- Opaque to this module. The CIM builder puts a block id here; deal-qa never
  -- learns what a CIM is. This single column is the whole integration contract.
  external_ref text,
  requestor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asked_at     timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz,
  due_date     date,
  closed_at    timestamptz,
  created_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qa_items_company_status ON qa_items (company_id, status);
CREATE INDEX IF NOT EXISTS idx_qa_items_company_category ON qa_items (company_id, category_id);
CREATE INDEX IF NOT EXISTS idx_qa_items_external_ref ON qa_items (external_ref)
  WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS qa_assignees (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'requestee'
    CHECK (kind IN ('requestee', 'delegate')),
  assigned_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  UNIQUE (item_id, user_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_qa_assignees_user ON qa_assignees (user_id)
  WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS qa_assignment_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  action         text NOT NULL
    CHECK (action IN ('assigned', 'reassigned', 'delegated', 'removed', 'status_changed')),
  prior_user_ids uuid[] NOT NULL DEFAULT '{}',
  new_user_ids   uuid[] NOT NULL DEFAULT '{}',
  actor_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note           text,
  at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qa_assignment_events_item ON qa_assignment_events (item_id, at);

-- Responses are INSERT-ONLY. There is no update path anywhere in the module, and
-- QA-0002's immutability is enforced by the absence of a route rather than by a
-- guard inside one.
--
-- A correction is a new row carrying supersedes_id and an incremented
-- answer_version; the only mutation is flipping the prior row's is_current. Every
-- version keeps its own citation_ref and posted_at, so a narrative citing v1 still
-- resolves. That is exactly QA-0002's "a follow-up does not invalidate a
-- narrative" — achieved by construction rather than by policy.
CREATE TABLE IF NOT EXISTS qa_responses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  citation_ref   text NOT NULL,
  kind           text NOT NULL DEFAULT 'answer'
    CHECK (kind IN ('answer', 'comment', 'clarification')),
  body           text NOT NULL,
  author_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  posted_at      timestamptz NOT NULL DEFAULT now(),
  supersedes_id  uuid REFERENCES qa_responses(id) ON DELETE SET NULL,
  answer_root_id uuid,
  answer_version integer NOT NULL DEFAULT 1,
  is_current     boolean NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX IF NOT EXISTS qa_responses_citation_uq ON qa_responses (citation_ref);
CREATE INDEX IF NOT EXISTS idx_qa_responses_item ON qa_responses (item_id, posted_at);
-- At most one live version per answer lineage, enforced by the database rather
-- than by the service remembering to.
CREATE UNIQUE INDEX IF NOT EXISTS qa_responses_current_root_uq
  ON qa_responses (answer_root_id)
  WHERE is_current AND kind = 'answer' AND answer_root_id IS NOT NULL;

-- The broker's reworded, presentation-ready version. A SEPARATE table, so it is
-- physically incapable of overwriting what the seller wrote. Versioned on its own
-- counter; only a published one is offered to a downstream consumer.
CREATE TABLE IF NOT EXISTS qa_presentations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id            uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  source_response_id uuid NOT NULL REFERENCES qa_responses(id) ON DELETE CASCADE,
  body               text NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  is_current         boolean NOT NULL DEFAULT true,
  status             text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published')),
  author_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qa_presentations_item ON qa_presentations (item_id, version);

-- An answer's evidence lands in the data room at a folder the respondent picks,
-- and is discoverable from either side.
CREATE TABLE IF NOT EXISTS qa_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  response_id  uuid REFERENCES qa_responses(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  folder_id    uuid REFERENCES folders(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (response_id, document_id)
);

-- Per-item visibility override (QA-0003). The exclusive-subject CHECK copies the
-- folder_access_subject idiom already used in the legacy schema.
CREATE TABLE IF NOT EXISTS qa_item_visibility (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  role_key     text,
  effect       text NOT NULL DEFAULT 'hide' CHECK (effect IN ('hide', 'allow')),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qa_item_visibility_subject CHECK ((user_id IS NOT NULL) <> (role_key IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_qa_item_visibility_item ON qa_item_visibility (item_id);

-- Seed each existing company's categories from the request_category vocabulary.
-- Idempotent: ON CONFLICT keeps a re-run from duplicating.
INSERT INTO qa_categories (company_id, key, label, sort_order)
SELECT c.id, v.key, v.label, v.sort_order
FROM companies c
CROSS JOIN (VALUES
  ('finance',    'Finance',    1),
  ('legal',      'Legal',      2),
  ('compliance', 'Compliance', 3),
  ('hr',         'HR',         4),
  ('tax',        'Tax',        5),
  ('ma',         'M&A',        6),
  ('other',      'Other',      7)
) AS v(key, label, sort_order)
ON CONFLICT (company_id, key) DO NOTHING;

COMMIT;
