-- CIM Module Schema
-- Run this in the Supabase SQL editor (once) to create all required tables.

CREATE TABLE IF NOT EXISTS cims (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status        VARCHAR(50) NOT NULL DEFAULT 'draft',
  section_data  JSONB       NOT NULL DEFAULT '{}',
  created_by    UUID        REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id)
);

CREATE TABLE IF NOT EXISTS cim_questionnaires (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cim_id        UUID        NOT NULL REFERENCES cims(id) ON DELETE CASCADE,
  title         TEXT        NOT NULL,
  category      TEXT,
  status        VARCHAR(50) NOT NULL DEFAULT 'draft',
  sent_at       TIMESTAMPTZ,
  answered_at   TIMESTAMPTZ,
  created_by    UUID        REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cim_questions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  questionnaire_id  UUID        NOT NULL REFERENCES cim_questionnaires(id) ON DELETE CASCADE,
  question_text     TEXT        NOT NULL,
  question_type     VARCHAR(50) NOT NULL DEFAULT 'text',
  is_required       BOOLEAN     NOT NULL DEFAULT false,
  sort_order        INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cim_question_responses (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id   UUID        NOT NULL REFERENCES cim_questions(id) ON DELETE CASCADE,
  answered_by   UUID        REFERENCES users(id),
  response_text TEXT,
  is_draft      BOOLEAN     NOT NULL DEFAULT true,
  submitted_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(question_id)
);

CREATE TABLE IF NOT EXISTS cim_review_comments (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cim_id         UUID        NOT NULL REFERENCES cims(id) ON DELETE CASCADE,
  reviewer_id    UUID        REFERENCES users(id),
  reviewer_name  TEXT,
  section_key    TEXT        NOT NULL DEFAULT '__global__',
  field_key      TEXT,
  comment_text   TEXT        NOT NULL,
  status         VARCHAR(50) NOT NULL DEFAULT 'open',
  resolved_by    UUID        REFERENCES users(id),
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe migrations for existing installations (no-op if columns already exist)
ALTER TABLE cim_review_comments ADD COLUMN IF NOT EXISTS field_key TEXT;
ALTER TABLE cim_review_comments ADD COLUMN IF NOT EXISTS reviewer_name TEXT;

CREATE TABLE IF NOT EXISTS cim_revision_history (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cim_id       UUID        NOT NULL REFERENCES cims(id) ON DELETE CASCADE,
  changed_by   UUID        REFERENCES users(id),
  section_key  TEXT,
  old_value    JSONB,
  new_value    JSONB,
  action       VARCHAR(50),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cim_generations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cim_id            UUID        NOT NULL REFERENCES cims(id) ON DELETE CASCADE,
  generated_by      UUID        REFERENCES users(id),
  file_name         TEXT,
  generation_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
