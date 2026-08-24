-- The CIM builder (CM - 0001), at narrative depth.
--
-- Shape: relational spine, jsonb leaves. Real tables for anything that needs a
-- version axis or an identity — deck, version, section, slide, block,
-- publication — and `cim_block.content` stays jsonb holding exactly the value the
-- existing renderer already understands.
--
-- That split is what makes this affordable. `WorkspaceCimPrep.jsx` is not a block
-- editor; it is a token-fill engine over 38 extracted slide layouts, and it
-- persists one flat map `fieldValues[fieldId] = string`. The field id is stable,
-- so `cim_block.block_key` holds it verbatim and the SPA's in-memory shape after
-- migration is identical to before.
--
-- What the blob could not express, and why this exists at all:
--   * no version axis — `workspace_page_state` is UNIQUE (company_id, page_key),
--     so "publish a frozen version, keep prior ones retrievable" is unsayable;
--   * no per-block identity — so an accepted answer has nothing to be written
--     against, and CM-0004's review flow has no target.
--
-- Deferred deliberately, and named so nobody has to guess: templates (CM-0002,
-- beyond the content_class attribute it requires this spec to carry), the .pptx
-- loader (CM-0003), the teaser (CM-0005), data-bound financial exhibits, the
-- anonymisation label map, and edit locks.

BEGIN;

-- A CIM belongs to exactly one deal, and holds its versions.
CREATE TABLE IF NOT EXISTS cim_decks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  template_key  text NOT NULL DEFAULT 'source-38',
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_cim_decks_company ON cim_decks (company_id, deleted_at);

-- One version of a deck's content.
--
-- `status` is the write lock: anything but draft or in_review refuses mutation.
-- The partial unique index below allows at most one unpublished version per deck,
-- so "the draft" is always unambiguous — a deck with two drafts has no answer to
-- "what am I editing".
CREATE TABLE IF NOT EXISTS cim_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id         uuid NOT NULL REFERENCES cim_decks(id) ON DELETE CASCADE,
  version_no      integer NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_review', 'seller_approved', 'published', 'archived')),
  cover           jsonb NOT NULL DEFAULT '{}'::jsonb,
  theme           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Recorded and displayed, but NOT gating publication. CM-0001 requires the
  -- gate; this change ships the record and defers the gate, which is a real
  -- weakening of a specified control and is called out in the proposal.
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  published_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deck_id, version_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS cim_versions_one_open
  ON cim_versions (deck_id)
  WHERE status IN ('draft', 'in_review');

CREATE TABLE IF NOT EXISTS cim_sections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id   uuid NOT NULL REFERENCES cim_versions(id) ON DELETE CASCADE,
  section_key  text NOT NULL,
  title        text NOT NULL,
  sort_order   integer NOT NULL,
  UNIQUE (version_id, section_key)
);

CREATE TABLE IF NOT EXISTS cim_slides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL REFERENCES cim_versions(id) ON DELETE CASCADE,
  section_id  uuid NOT NULL REFERENCES cim_sections(id) ON DELETE CASCADE,
  -- Declared now though no exhibit ships: adding the axis later would mean a
  -- migration over content that already exists.
  slide_class text NOT NULL DEFAULT 'qualitative'
    CHECK (slide_class IN ('qualitative', 'financial_exhibit')),
  layout_key  text NOT NULL,
  slide_no    integer NOT NULL,
  sort_order  integer NOT NULL,
  UNIQUE (version_id, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_cim_slides_section ON cim_slides (section_id, sort_order);

-- One addressable piece of slide content.
--
-- `block_key` is the SPA's existing field id, verbatim — that is what lets the
-- god-file be re-pointed rather than rewritten.
--
-- `content_class` is required by CM-0002, which states CM-0001 must carry it.
-- It ships now because retrofitting a classification onto content already
-- authored is expensive, and getting it wrong is a confidentiality incident
-- rather than a bug: firm boilerplate travels into templates and deal content
-- must not. `content_class_locked` is set permanently when an answer or an
-- import populates a block, so answer-derived text can never be reclassified.
CREATE TABLE IF NOT EXISTS cim_blocks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id            uuid NOT NULL REFERENCES cim_versions(id) ON DELETE CASCADE,
  slide_id              uuid NOT NULL REFERENCES cim_slides(id) ON DELETE CASCADE,
  block_key             text NOT NULL,
  kind                  text NOT NULL DEFAULT 'text'
    CHECK (kind IN ('text', 'image', 'table', 'chart', 'repeatable')),
  label                 text,
  content               jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_class         text NOT NULL DEFAULT 'deal'
    CHECK (content_class IN ('deal', 'firm_boilerplate')),
  content_class_locked  boolean NOT NULL DEFAULT false,
  populated_by          text
    CHECK (populated_by IS NULL OR populated_by IN ('author', 'answer', 'loader', 'autofill')),
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, block_key)
);

CREATE INDEX IF NOT EXISTS idx_cim_blocks_gaps ON cim_blocks (version_id, populated_by);

-- The question library (CM - 0004).
--
-- Seeded from the ~373 authored labels already living in the god-file, most of
-- them already phrased as questions and already bound to a block. Scope mirrors
-- CM-0002: system, firm, user.
CREATE TABLE IF NOT EXISTS cim_question_library (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope              text NOT NULL DEFAULT 'system'
    CHECK (scope IN ('system', 'firm', 'user')),
  owner_id           uuid,
  section_key        text NOT NULL,
  layout_key         text,
  block_key_pattern  text,
  question_text      text NOT NULL,
  help_text          text,
  sort_order         integer NOT NULL DEFAULT 0,
  archived_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_cim_question_library_lookup
  ON cim_question_library (scope, section_key, archived_at);

-- Where a block's content came from.
--
-- `raw_answer` holds what the respondent actually submitted, preserved even
-- where the broker edited it before accepting — so "who said this" survives the
-- edit that made it presentable.
CREATE TABLE IF NOT EXISTS cim_block_provenance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id       uuid NOT NULL REFERENCES cim_blocks(id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('qa_answer', 'loader', 'autofill', 'broker')),
  qa_item_id     text,
  qa_response_id text,
  respondent_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  answered_at    timestamptz,
  accepted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  outcome        text NOT NULL DEFAULT 'accepted'
    CHECK (outcome IN ('accepted', 'discarded')),
  raw_answer     text
);

CREATE INDEX IF NOT EXISTS idx_cim_block_provenance_block ON cim_block_provenance (block_id);

-- The published artifact.
--
-- Content-addressed: "did this change" is a hash comparison, which is what makes
-- the frozen version checkable rather than merely asserted.
CREATE TABLE IF NOT EXISTS cim_publications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id    uuid NOT NULL UNIQUE REFERENCES cim_versions(id) ON DELETE CASCADE,
  upload_id     uuid REFERENCES uploads(id) ON DELETE SET NULL,
  document_id   uuid REFERENCES documents(id) ON DELETE SET NULL,
  sha256        text NOT NULL,
  page_count    integer,
  byte_size     bigint,
  published_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at  timestamptz NOT NULL DEFAULT now()
);

-- Carry existing CIM work across from the JSON blob.
--
-- Guarded with `to_regclass`: a database built from packages/db alone has no
-- `workspace_page_state`, and an unguarded INSERT..SELECT against a missing
-- table fails to PARSE rather than merely to run — the whole migration would
-- abort. Same pattern 0002_qoe_bridge uses for `ebitda_adjustments`.
--
-- The blob rows are read, never deleted: the legacy path stays a working
-- rollback target, which is what makes CIM_MODULE_ENABLED=false a real fallback.
DO $$
DECLARE
  row_rec record;
  deck uuid;
  ver uuid;
  sect uuid;
  slide uuid;
BEGIN
  IF to_regclass('public.workspace_page_state') IS NULL THEN
    RETURN;
  END IF;

  FOR row_rec IN
    SELECT company_id, payload FROM workspace_page_state WHERE page_key = 'cim-prep'
  LOOP
    IF EXISTS (SELECT 1 FROM cim_decks WHERE company_id = row_rec.company_id) THEN
      CONTINUE;
    END IF;

    INSERT INTO cim_decks (company_id, name)
    VALUES (row_rec.company_id, 'Confidential Information Memorandum')
    RETURNING id INTO deck;

    INSERT INTO cim_versions (deck_id, version_no, status, cover)
    VALUES (deck, 1, 'draft', COALESCE(row_rec.payload -> 'globalDetails', '{}'::jsonb))
    RETURNING id INTO ver;

    -- One catch-all section and slide: the imported map is keyed by field id and
    -- carries no section structure of its own, and inventing one would be a
    -- guess. The editor reassigns blocks to real slides on first save.
    INSERT INTO cim_sections (version_id, section_key, title, sort_order)
    VALUES (ver, 'imported', 'Imported', 1)
    RETURNING id INTO sect;

    INSERT INTO cim_slides (version_id, section_id, layout_key, slide_no, sort_order)
    VALUES (ver, sect, 'source-slide-01', 1, 1)
    RETURNING id INTO slide;

    INSERT INTO cim_blocks (version_id, slide_id, block_key, kind, content, populated_by)
    SELECT ver, slide, kv.key, 'text', to_jsonb(kv.value), 'author'
    FROM jsonb_each_text(COALESCE(row_rec.payload -> 'fieldValues', '{}'::jsonb)) AS kv
    WHERE kv.value IS NOT NULL AND kv.value <> ''
    ON CONFLICT (version_id, block_key) DO NOTHING;
  END LOOP;
END $$;

COMMIT;
