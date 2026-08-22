-- Breadth seed: turns the demo from "one of each" into a populated portfolio.
--
-- The existing seeds build a narrow, exact fixture around Acme Manufacturing —
-- six requests, five Q&A items, three versions of one model — and both up.sh and
-- reset.sh assert those counts. This file deliberately adds NOTHING to Acme. It
-- widens everything around it instead:
--
--   * five more companies, so the portfolio list is a list rather than a pair
--   * eight more people, so "assigned to" and "asked by" are real names
--   * folder trees, documents with real bytes, and version history per company
--   * the tables that were empty on every screen a visitor could reach:
--     activity, reminders, messages, folder grants, buyer groups, document
--     activity, file references, user preferences
--
-- Why Acme is untouched: `up.sh` checks `/companies/$ACME/requests` == 6 and
-- `/qa/companies/$ACME/items` == 5, and `d[0]['name']` == 'Project Atlas CIM' on
-- Acme's decks. Seeding into Acme would break the verification suite that makes
-- the demo trustworthy. Northwind and the five new companies carry the volume.
--
-- Idempotent, and re-runnable against a live stack. Ids are derived rather than
-- hand-written: `derived_id(prefix, key)` is an md5 of a stable natural key
-- projected into a reserved UUID prefix, so the same row always gets the same id
-- without a hundred literal UUIDs to keep unique by hand. The whole `9x` prefix
-- space is reserved for this file; the older seeds use a0/a1/b0/b2/c0/d0/d1/e0/f0.

BEGIN;

-- Deterministic id in a reserved prefix. Same inputs -> same uuid, forever, which
-- is what makes every INSERT below idempotent without literal ids.
CREATE OR REPLACE FUNCTION pg_temp.derived_id(prefix text, key text)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT (prefix || '-0000-4000-8000-' || substr(md5(key), 1, 12))::uuid;
$$;

-- Shorthands for the people the older seeds created.
-- b0..01 Avery Admin, b0..02 Blake Broker, b0..03 Dana Client.
CREATE OR REPLACE FUNCTION pg_temp.admin_id() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'b0000000-0000-4000-8000-000000000001'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.broker_id() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'b0000000-0000-4000-8000-000000000002'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.client_id() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'b0000000-0000-4000-8000-000000000003'::uuid $$;


-- ── companies ───────────────────────────────────────────────────────────────
-- Five more live mandates. Deliberately spread across industries and both profit
-- metrics, because the QoE bridge renders "Adjusted EBITDA" or "SDE" off this
-- column and a demo where every company is identical proves nothing.
INSERT INTO companies (id, name, industry, status, contact_name, contact_email,
                       contact_phone, profit_metric, project_name, since)
VALUES
  ('90000000-0000-4000-8000-000000000001', 'Harbor Point Medical Supply',
   'Healthcare Distribution', 'active', 'Grace Lin', 'owner.lin@demo.test',
   '+1 617 555 0142', 'sde', 'Project Lighthouse', DATE '2026-02-11'),
  ('90000000-0000-4000-8000-000000000002', 'Ridgeline Precision Tooling',
   'Industrial Manufacturing', 'active', 'Tom Reyes', 'owner.reyes@demo.test',
   '+1 414 555 0188', 'adjusted_ebitda', 'Project Anvil', DATE '2026-03-04'),
  ('90000000-0000-4000-8000-000000000003', 'Bluewater Marine Services',
   'Marine Services', 'active', 'Sam Owner', 'owner@northwind.test',
   '+1 305 555 0119', 'sde', 'Project Tide', DATE '2026-04-22'),
  ('90000000-0000-4000-8000-000000000004', 'Copperfield Retail Group',
   'Specialty Retail', 'active', 'Grace Lin', 'owner.lin@demo.test',
   '+1 312 555 0170', 'adjusted_ebitda', 'Project Copper', DATE '2026-05-30'),
  -- Inactive on purpose: the portfolio filter has nothing to filter otherwise.
  ('90000000-0000-4000-8000-000000000005', 'Summit Grove Foods',
   'Food & Beverage', 'inactive', 'Tom Reyes', 'owner.reyes@demo.test',
   '+1 503 555 0163', 'adjusted_ebitda', 'Project Orchard', DATE '2025-11-08')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, industry = EXCLUDED.industry, status = EXCLUDED.status,
  contact_name = EXCLUDED.contact_name, contact_email = EXCLUDED.contact_email,
  contact_phone = EXCLUDED.contact_phone, profit_metric = EXCLUDED.profit_metric,
  project_name = EXCLUDED.project_name;


-- ── people ──────────────────────────────────────────────────────────────────
-- Same bcrypt digest of `demo1234` the base seed uses, so every one of these can
-- actually sign in once the Better Auth backfill runs (see seed-extra.sh). A
-- seeded name that cannot log in is a name on a dropdown and nothing more.
--
-- The role enum is only (admin, broker, buyer) — there is no `seller` — so
-- seller-side contacts are modelled as `buyer` with a sub_role, which is what the
-- base seed already does with Dana Client.
INSERT INTO users (id, name, email, password_hash, role, company_id, status,
                   sub_role, designation, buyer_company_name, broker_company)
VALUES
  ('91000000-0000-4000-8000-000000000001', 'Rosa Marquez', 'broker2@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'broker',
   '90000000-0000-4000-8000-000000000001', 'active',
   NULL, 'Managing Director', NULL, 'Sage M&A Partners'),
  ('91000000-0000-4000-8000-000000000002', 'Owen Bright', 'broker3@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'broker',
   '90000000-0000-4000-8000-000000000002', 'active',
   NULL, 'Associate', NULL, 'Sage M&A Partners'),
  ('91000000-0000-4000-8000-000000000003', 'Elena Fischer', 'analyst@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'admin',
   NULL, 'active', NULL, 'Diligence Analyst', NULL, 'Sage M&A Partners'),
  ('91000000-0000-4000-8000-000000000004', 'Ken Tanaka', 'buyer.tanaka@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   '90000000-0000-4000-8000-000000000001', 'active',
   'buyer', 'Head of Corp Dev', 'Meridian Health Partners', NULL),
  ('91000000-0000-4000-8000-000000000005', 'Priya Nair', 'buyer.nair@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   '90000000-0000-4000-8000-000000000002', 'active',
   'buyer', 'Principal', 'Kestrel Industrial Capital', NULL),
  ('91000000-0000-4000-8000-000000000006', 'Marcus Webb', 'buyer.webb@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   '90000000-0000-4000-8000-000000000004', 'active',
   'buyer', 'Partner', 'Copperline Equity', NULL),
  ('91000000-0000-4000-8000-000000000007', 'Grace Lin', 'owner.lin@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   '90000000-0000-4000-8000-000000000001', 'active',
   'seller', 'Founder & CEO', NULL, NULL),
  ('91000000-0000-4000-8000-000000000008', 'Tom Reyes', 'owner.reyes@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   '90000000-0000-4000-8000-000000000002', 'active',
   'seller', 'Owner', NULL, NULL),
  -- A second bidder on each mandate, so every company has a contested process and
  -- the buyer groups, folder grants and "who viewed this" list are never a
  -- single name. Companies 3 and 5 would otherwise have no buyer at all.
  ('91000000-0000-4000-8000-000000000009', 'Dale Okonkwo', 'buyer.okonkwo@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   '90000000-0000-4000-8000-000000000001', 'active',
   'buyer', 'Investment Director', 'Ashfield Health Capital', NULL),
  ('91000000-0000-4000-8000-00000000000a', 'Ingrid Sole', 'buyer.sole@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   '90000000-0000-4000-8000-000000000003', 'active',
   'buyer', 'Managing Partner', 'Tidewater Holdings', NULL),
  ('91000000-0000-4000-8000-00000000000b', 'Hugo Braun', 'buyer.braun@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   '90000000-0000-4000-8000-000000000005', 'active',
   'buyer', 'Head of M&A', 'Orchard Lane Group', NULL),
  ('91000000-0000-4000-8000-00000000000c', 'Nadia Rahman', 'buyer.rahman@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   '90000000-0000-4000-8000-000000000004', 'active',
   'buyer', 'Vice President', 'Copperline Equity', NULL)
ON CONFLICT (id) DO UPDATE SET
  password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
  name = EXCLUDED.name, status = EXCLUDED.status, sub_role = EXCLUDED.sub_role,
  designation = EXCLUDED.designation;

-- Blake Broker works every new mandate, so signing in as the documented demo
-- account shows the full portfolio rather than the original two companies.
INSERT INTO user_companies (user_id, company_id)
SELECT pg_temp.broker_id(), c.id FROM companies c WHERE c.id::text LIKE '90%'
ON CONFLICT DO NOTHING;

-- Everyone else gets a narrower slice, which is what makes tenant scoping
-- demonstrable: sign in as Ken Tanaka and four of the six companies vanish.
INSERT INTO user_companies (user_id, company_id)
VALUES
  ('91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001'),
  ('91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000003'),
  ('91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000004'),
  ('91000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000002'),
  ('91000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000005'),
  ('91000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000001'),
  ('91000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000002'),
  ('91000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-000000000004'),
  ('91000000-0000-4000-8000-000000000007', '90000000-0000-4000-8000-000000000001'),
  ('91000000-0000-4000-8000-000000000008', '90000000-0000-4000-8000-000000000002'),
  ('91000000-0000-4000-8000-000000000009', '90000000-0000-4000-8000-000000000001'),
  ('91000000-0000-4000-8000-00000000000a', '90000000-0000-4000-8000-000000000003'),
  ('91000000-0000-4000-8000-00000000000b', '90000000-0000-4000-8000-000000000005'),
  ('91000000-0000-4000-8000-00000000000c', '90000000-0000-4000-8000-000000000004')
ON CONFLICT DO NOTHING;

-- Q&A categories for the new companies. Same vocabulary and the same reason as
-- the base seed: migration 0003 only backfills companies that existed when it
-- ran, and these did not.
INSERT INTO qa_categories (company_id, key, label, sort_order)
SELECT c.id, v.key, v.label, v.sort_order
FROM companies c
CROSS JOIN (VALUES
  ('finance','Finance',1), ('legal','Legal',2), ('compliance','Compliance',3),
  ('hr','HR',4), ('tax','Tax',5), ('ma','M&A',6), ('other','Other',7)
) AS v(key, label, sort_order)
WHERE c.id::text LIKE '90%'
ON CONFLICT (company_id, key) DO NOTHING;


-- ── folder trees ────────────────────────────────────────────────────────────
-- A six-folder top level per new company, plus two children under Financials.
-- Generated rather than written out: 5 companies x 8 folders is 40 rows nobody
-- should be hand-maintaining, and the derived ids keep it idempotent.
INSERT INTO folders (id, company_id, name, parent_id, created_by, created_at)
SELECT pg_temp.derived_id('92000000', c.id::text || v.name), c.id, v.name, NULL,
       pg_temp.broker_id(), now() - (v.age || ' days')::interval
FROM companies c
CROSS JOIN (VALUES
  ('Financials', 60), ('Legal', 58), ('Tax', 55), ('HR', 50),
  ('Operations', 44), ('Contracts', 39)
) AS v(name, age)
WHERE c.id::text LIKE '90%'
  -- `folders_company_parent_name_uq` is on (company_id, parent_id, name), so a
  -- folder of the same name created by another seed would collide on a
  -- constraint this statement's ON CONFLICT (id) cannot catch.
  AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.company_id = c.id
                    AND f.parent_id IS NULL AND f.name = v.name)
ON CONFLICT (id) DO NOTHING;

INSERT INTO folders (id, company_id, name, parent_id, created_by, created_at)
SELECT pg_temp.derived_id('92000000', c.id::text || v.name), c.id, v.name,
       pg_temp.derived_id('92000000', c.id::text || 'Financials'),
       pg_temp.broker_id(), now() - (v.age || ' days')::interval
FROM companies c
CROSS JOIN (VALUES
  ('Monthly Close', 33), ('Bank Statements', 30)
) AS v(name, age)
WHERE c.id::text LIKE '90%'
  AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.company_id = c.id
                    AND f.parent_id = pg_temp.derived_id('92000000', c.id::text || 'Financials')
                    AND f.name = v.name)
ON CONFLICT (id) DO NOTHING;

-- Northwind had a single empty 'Financials' folder. Give it the same tree, so the
-- second company on the original demo account is not visibly thinner than the new
-- ones a visitor clicks into afterwards.
INSERT INTO folders (id, company_id, name, parent_id, created_by, created_at)
SELECT pg_temp.derived_id('92000000', 'a0000000-0000-4000-8000-000000000002' || v.name),
       'a0000000-0000-4000-8000-000000000002', v.name, NULL,
       pg_temp.broker_id(), now() - (v.age || ' days')::interval
FROM (VALUES ('Legal', 57), ('Tax', 54), ('Operations', 43), ('Contracts', 38))
  AS v(name, age)
WHERE NOT EXISTS (
  SELECT 1 FROM folders f
  WHERE f.company_id = 'a0000000-0000-4000-8000-000000000002'
    AND f.parent_id IS NULL AND f.name = v.name)
ON CONFLICT (id) DO NOTHING;


-- ── documents, with real bytes ──────────────────────────────────────────────
-- Real content for the same reason seed-dataroom.sql uses it: a document that
-- previews as empty is indistinguishable from a broken one. The body carries the
-- company name so a visitor clicking two companies sees genuinely different files
-- rather than the same placeholder twice.
CREATE TEMP TABLE demo_doc_spec AS
SELECT
  c.id                                     AS company_id,
  c.name                                   AS company_name,
  v.folder                                 AS folder_name,
  v.file_name,
  v.body_hint,
  v.age_days,
  v.status,
  v.versions,
  v.owner
FROM companies c
CROSS JOIN (VALUES
  ('Financials',      'Trial Balance FY2025.txt', 'Trial balance, FY2025 — unaudited', 47, 'verified',     2, 'broker'),
  ('Financials',      'P&L Summary FY2025.txt',   'Profit & loss summary, FY2025',     45, 'verified',     1, 'broker'),
  ('Monthly Close',   'Close Checklist Jun.txt',  'Month-end close checklist — June',  28, 'under-review', 1, 'client'),
  ('Bank Statements', 'Operating Account Jun.txt','Operating account statement — June',26, 'verified',     1, 'client'),
  ('Legal',           'Articles of Incorporation.txt', 'Articles of incorporation, as filed', 52, 'verified', 1, 'broker'),
  ('Legal',           'Shareholder Agreement.txt','Shareholder agreement — current',   41, 'under-review', 3, 'broker'),
  ('Tax',             'Federal Return 2024.txt',  'Federal return, tax year 2024',     49, 'verified',     1, 'client'),
  ('HR',              'Org Chart.txt',            'Organisation chart — headcount 84', 35, 'under-review', 1, 'client'),
  ('HR',              'Benefits Summary.txt',     'Benefits summary — plan year 2026', 33, 'verified',     1, 'client'),
  ('Operations',      'Customer Concentration.txt','Top-10 customer concentration',    22, 'under-review', 2, 'broker'),
  ('Contracts',       'Master Supply Agreement.txt','Master supply agreement — renewed',18,'verified',     1, 'broker'),
  -- One rejected document per company, so the status filter has all three values.
  ('Contracts',       'Superseded Terms.txt',     'Superseded terms — do not rely on', 15, 'rejected',     1, 'client')
) AS v(folder, file_name, body_hint, age_days, status, versions, owner)
WHERE c.id::text LIKE '90%';

-- The stored bytes. One upload row per document version.
INSERT INTO uploads (id, file_name, content_type, size_bytes, data, prefix, uploaded_by, created_at)
SELECT
  pg_temp.derived_id('94000000', s.company_id::text || s.file_name || g.n::text),
  s.file_name, 'text/plain',
  length(convert_to(s.body_hint || ' — ' || s.company_name || ' (v' || g.n || ')', 'UTF8')),
  convert_to(s.body_hint || ' — ' || s.company_name || ' (v' || g.n || ')', 'UTF8'),
  'documents',
  CASE s.owner WHEN 'broker' THEN pg_temp.broker_id() ELSE pg_temp.client_id() END,
  now() - (s.age_days || ' days')::interval
FROM demo_doc_spec s
CROSS JOIN LATERAL generate_series(1, s.versions) AS g(n)
ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, size_bytes = EXCLUDED.size_bytes;

INSERT INTO documents (id, company_id, folder_id, name, file_url, upload_id, size, ext,
                       status, uploaded_by, uploaded_at, version_count)
SELECT
  pg_temp.derived_id('93000000', s.company_id::text || s.file_name),
  s.company_id,
  pg_temp.derived_id('92000000', s.company_id::text || s.folder_name),
  s.file_name, '',
  -- Current upload is the highest-numbered version.
  pg_temp.derived_id('94000000', s.company_id::text || s.file_name || s.versions::text),
  length(convert_to(s.body_hint || ' — ' || s.company_name || ' (v' || s.versions || ')', 'UTF8'))::text,
  'txt', s.status::document_status,
  CASE s.owner WHEN 'broker' THEN pg_temp.broker_id() ELSE pg_temp.client_id() END,
  now() - (s.age_days || ' days')::interval,
  s.versions
FROM demo_doc_spec s
ON CONFLICT (id) DO UPDATE SET
  upload_id = EXCLUDED.upload_id, version_count = EXCLUDED.version_count,
  status = EXCLUDED.status;

INSERT INTO document_versions (id, document_id, version_no, upload_id, file_name,
                               size_bytes, content_type, note, created_by, created_at)
SELECT
  pg_temp.derived_id('95000000', s.company_id::text || s.file_name || g.n::text),
  pg_temp.derived_id('93000000', s.company_id::text || s.file_name),
  g.n,
  pg_temp.derived_id('94000000', s.company_id::text || s.file_name || g.n::text),
  s.file_name,
  length(convert_to(s.body_hint || ' — ' || s.company_name || ' (v' || g.n || ')', 'UTF8')),
  'text/plain',
  CASE WHEN g.n = 1 THEN NULL ELSE 'Revised after diligence review' END,
  CASE s.owner WHEN 'broker' THEN pg_temp.broker_id() ELSE pg_temp.client_id() END,
  now() - ((s.age_days - (g.n - 1) * 6) || ' days')::interval
FROM demo_doc_spec s
CROSS JOIN LATERAL generate_series(1, s.versions) AS g(n)
ON CONFLICT (id) DO NOTHING;

UPDATE documents d SET current_version_id = pg_temp.derived_id(
  '95000000', s.company_id::text || s.file_name || s.versions::text)
FROM demo_doc_spec s
WHERE d.id = pg_temp.derived_id('93000000', s.company_id::text || s.file_name);


-- ── document comments ───────────────────────────────────────────────────────
-- The internal/shared split, on the document most likely to be opened first.
INSERT INTO document_comments (id, document_id, company_id, author_id, body, visibility, created_at)
SELECT
  pg_temp.derived_id('96000000', s.company_id::text || v.tag),
  pg_temp.derived_id('93000000', s.company_id::text || s.file_name),
  s.company_id,
  CASE v.tag WHEN 'internal' THEN pg_temp.broker_id() ELSE pg_temp.client_id() END,
  v.body, v.visibility, now() - (v.age || ' hours')::interval
FROM demo_doc_spec s
CROSS JOIN (VALUES
  ('internal', 'Tie this back to the QoE bridge before it goes to the buyer.', 'internal', 30),
  ('shared',   'Updated copy attached — the prior version omitted December.',  'shared',   6)
) AS v(tag, body, visibility, age)
WHERE s.file_name = 'Trial Balance FY2025.txt'
ON CONFLICT (id) DO NOTHING;


-- ── document activity ───────────────────────────────────────────────────────
-- Who opened what. Empty until now, which made the "who has seen this" column on
-- every document read as though nobody had ever looked at anything.
INSERT INTO document_activity (id, document_id, user_id, activity_type, created_at, actor_id, action, at)
SELECT
  pg_temp.derived_id('97000000', d.id::text || u.user_id::text || v.kind),
  d.id, u.user_id, v.kind::document_activity_type,
  now() - (v.age || ' hours')::interval,
  u.user_id, v.kind, now() - (v.age || ' hours')::interval
FROM documents d
JOIN user_companies u ON u.company_id = d.company_id
CROSS JOIN (VALUES ('view', 20), ('download', 9)) AS v(kind, age)
WHERE d.company_id::text LIKE '90%'
ON CONFLICT (id) DO NOTHING;


-- ── folder grants ───────────────────────────────────────────────────────────
-- Buyers get read+download on the folders a buyer should see, and nothing on HR
-- or Contracts. This is the table that makes "folder grants mean something"
-- visible rather than merely enforced.
INSERT INTO folder_access (id, folder_id, user_id, can_read, can_write, can_download, created_by)
SELECT
  pg_temp.derived_id('98000000', f.id::text || u.user_id::text),
  f.id, u.user_id, true, false, true, pg_temp.broker_id()
FROM folders f
JOIN user_companies u ON u.company_id = f.company_id
JOIN users usr ON usr.id = u.user_id AND usr.role = 'buyer' AND usr.sub_role = 'buyer'
WHERE f.company_id::text LIKE '90%'
  AND f.name IN ('Financials', 'Legal', 'Tax', 'Operations')
ON CONFLICT (id) DO NOTHING;


-- ── buyer groups ────────────────────────────────────────────────────────────
INSERT INTO buyer_groups (id, company_id, name, description)
SELECT pg_temp.derived_id('99000000', c.id::text || v.name), c.id, v.name, v.descr
FROM companies c
CROSS JOIN (VALUES
  ('Round 1 — IOI', 'Buyers holding an indication of interest. Financials and Legal only.'),
  ('Round 2 — LOI', 'Shortlist under letter of intent. Full room, including Contracts.')
) AS v(name, descr)
WHERE c.id::text LIKE '90%'
ON CONFLICT (id) DO NOTHING;

-- Round 1 holds every bidder; Round 2 is the shortlist that survived. Modelling
-- the narrowing rather than putting everyone in both is what makes the group
-- switch on the folder-grant screen worth clicking.
INSERT INTO buyer_group_members (group_id, user_id)
SELECT pg_temp.derived_id('99000000', u.company_id::text || 'Round 1 — IOI'), u.user_id
FROM user_companies u
JOIN users usr ON usr.id = u.user_id AND usr.role = 'buyer' AND usr.sub_role = 'buyer'
WHERE u.company_id::text LIKE '90%'
ON CONFLICT DO NOTHING;

INSERT INTO buyer_group_members (group_id, user_id)
SELECT pg_temp.derived_id('99000000', ranked.company_id::text || 'Round 2 — LOI'),
       ranked.user_id
FROM (
  SELECT u.company_id, u.user_id,
         row_number() OVER (PARTITION BY u.company_id ORDER BY u.user_id) AS rn
  FROM user_companies u
  JOIN users usr ON usr.id = u.user_id AND usr.role = 'buyer' AND usr.sub_role = 'buyer'
  WHERE u.company_id::text LIKE '90%'
) ranked
WHERE ranked.rn = 1
ON CONFLICT DO NOTHING;


-- ── requests board ──────────────────────────────────────────────────────────
-- Eight per new company, covering every status, category and priority the board
-- renders. Acme keeps its six untouched, because up.sh asserts that number.
--
-- Due dates are relative to now() for the same reason the Acme seed makes them
-- relative: a literal date drifts and eventually turns every board red.
CREATE TEMP TABLE demo_request_spec AS
SELECT c.id AS company_id, v.*
FROM companies c
CROSS JOIN (VALUES
  ('Three years of audited financials', 'FY2023-FY2025', 'Signed audit opinions for each of the last three fiscal years.', 'Finance',    'Upload',    'critical', 'completed', -21,  9),
  ('Aged receivables as at month end',  'AR ageing',     'Aged debtor listing, bucketed 30/60/90/120+.',                  'Finance',    'Upload',    'high',     'in-review', -6,   4),
  ('Customer concentration analysis',   'Top 10',        'Revenue by customer for the top ten, three years.',             'Finance',    'Both',      'high',     'pending',    7,   0),
  ('Corporate structure chart',         'Legal entities','All entities, ownership percentages, and jurisdictions.',       'Legal',      'Upload',    'medium',   'completed', -14,  6),
  ('Outstanding litigation summary',    NULL,            'Any live or threatened claim above $25k.',                      'Legal',      'Narrative', 'high',     'blocked',   -3,   2),
  ('Employee census',                   'Headcount',     'Role, tenure, location and compensation band for every employee.','HR',       'Upload',    'medium',   'pending',   12,   0),
  ('State tax nexus review',            NULL,            'States with filing obligations, and current standing in each.', 'Tax',        'Both',      'low',      'pending',   19,   0),
  ('Insurance certificates',            'Current year',  'Certificates of insurance for all active policies.',            'Compliance', 'Upload',    'low',      'in-review', -1,   1)
) AS v(title, sub_label, descr, category, response_type, priority, status, due_offset, age_days)
WHERE c.id::text LIKE '90%';

INSERT INTO requests (id, company_id, title, sub_label, description, category,
                      response_type, priority, status, due_date, assigned_to,
                      created_by, submission_source, approval_status, created_at)
SELECT
  pg_temp.derived_id('9a000000', s.company_id::text || s.title),
  s.company_id, s.title, s.sub_label, s.descr,
  s.category::request_category, s.response_type::response_type,
  s.priority::request_priority, s.status::request_status,
  (now() + (s.due_offset || ' days')::interval)::date,
  pg_temp.client_id(), pg_temp.broker_id(), 'broker', 'approved',
  now() - (s.age_days + 10 || ' days')::interval
FROM demo_request_spec s
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status, due_date = EXCLUDED.due_date, priority = EXCLUDED.priority;

-- One seller-submitted request per company still awaiting broker approval, so the
-- approval gate has something to act on wherever a visitor happens to land.
INSERT INTO requests (id, company_id, title, sub_label, description, category,
                      response_type, priority, status, due_date, assigned_to,
                      created_by, submission_source, approval_status, created_at)
SELECT
  pg_temp.derived_id('9a000000', c.id::text || 'seller-submitted'),
  c.id, 'Equipment appraisal (seller submitted)', 'Awaiting approval',
  'Third-party appraisal of the machining line, submitted ahead of the request.',
  'Finance'::request_category, 'Upload'::response_type,
  'medium'::request_priority, 'pending'::request_status,
  (now() + interval '10 days')::date,
  pg_temp.client_id(), pg_temp.client_id(), 'seller', 'pending',
  now() - interval '2 days'
FROM companies c WHERE c.id::text LIKE '90%'
ON CONFLICT (id) DO UPDATE SET approval_status = EXCLUDED.approval_status;

-- Narratives on the requests whose response_type admits one.
INSERT INTO request_narratives (id, request_id, content, updated_by, updated_at)
SELECT
  pg_temp.derived_id('9b000000', r.id::text),
  r.id,
  'Nothing outstanding above the threshold. One historical claim with a former '
  || 'supplier was settled in 2024 with no continuing obligation; the settlement '
  || 'agreement is filed under Legal.',
  pg_temp.client_id(), now() - interval '3 days'
FROM requests r
WHERE r.company_id::text LIKE '90%' AND r.response_type IN ('Narrative', 'Both')
ON CONFLICT (id) DO NOTHING;

-- Link the completed financials request to the trial balance it was answered with.
INSERT INTO request_documents (id, request_id, document_id, visible)
SELECT
  pg_temp.derived_id('9c000000', r.id::text || d.id::text),
  r.id, d.id, true
FROM requests r
JOIN documents d ON d.company_id = r.company_id AND d.name = 'Trial Balance FY2025.txt'
WHERE r.company_id::text LIKE '90%' AND r.title = 'Three years of audited financials'
ON CONFLICT (id) DO NOTHING;


-- ── Q&A ─────────────────────────────────────────────────────────────────────
-- Six per new company, mixed open/answered, so the board is not a single column.
-- Acme keeps exactly five, which up.sh asserts.
-- `qa_responses.citation_ref` carries a GLOBAL unique index, so a reference has
-- to be unique across companies, not just within one. Each company gets a short
-- code and every reference and citation is prefixed with it — which is also how a
-- real deal room labels them.
CREATE TEMP TABLE demo_qa_spec AS
SELECT c.id AS company_id, cc.code, v.*
FROM companies c
JOIN (VALUES
  ('90000000-0000-4000-8000-000000000001'::uuid, 'HPM'),
  ('90000000-0000-4000-8000-000000000002'::uuid, 'RPT'),
  ('90000000-0000-4000-8000-000000000003'::uuid, 'BMS'),
  ('90000000-0000-4000-8000-000000000004'::uuid, 'CRG'),
  ('90000000-0000-4000-8000-000000000005'::uuid, 'SGF')
) AS cc(company_id, code) ON cc.company_id = c.id
CROSS JOIN (VALUES
  ('finance','QA-101','Gross margin drift','Margin fell 240bps year over year. Is that mix, price, or input cost?','answered','high','QE','Revenue', 14, 11),
  ('finance','QA-102','Working capital seasonality','Describe the intra-year working capital swing and its peak funding need.','answered','medium','QE','Working Capital', 12, 8),
  ('legal','QA-103','Change of control provisions','Which customer or supplier contracts carry change-of-control consent?','open','critical','Legal','Contracts', 9, NULL),
  ('tax','QA-104','R&D credit position','Has an R&D credit been claimed, and is the study documented?','open','medium','Tax','Credits', 7, NULL),
  ('hr','QA-105','Key person dependency','Which roles would be hardest to replace, and is there a retention plan?','answered','high','HR','People', 6, 3),
  ('compliance','QA-106','Licensing and permits','List every operating licence and its renewal date.','open','low','Compliance','Permits', 4, NULL)
) AS v(cat_key, reference, title, body, status, priority, module_tag, section_tag, asked_days, answered_days)
WHERE c.id::text LIKE '90%';

INSERT INTO qa_items (id, company_id, category_id, reference, title, body, status,
                      priority, origin, module_tag, section_tag, requestor_id,
                      created_by, asked_at, answered_at, due_date)
SELECT
  pg_temp.derived_id('9d000000', s.company_id::text || s.reference),
  s.company_id,
  (SELECT id FROM qa_categories q WHERE q.company_id = s.company_id AND q.key = s.cat_key),
  s.code || '-' || s.reference, s.title, s.body, s.status, s.priority, 'manual',
  s.module_tag, s.section_tag,
  pg_temp.broker_id(), pg_temp.broker_id(),
  now() - (s.asked_days || ' days')::interval,
  CASE WHEN s.answered_days IS NULL THEN NULL
       ELSE now() - (s.answered_days || ' days')::interval END,
  (now() + interval '14 days')::date
FROM demo_qa_spec s
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, answered_at = EXCLUDED.answered_at;

INSERT INTO qa_responses (id, item_id, citation_ref, kind, body, author_id, posted_at,
                          answer_root_id, answer_version, is_current)
SELECT
  pg_temp.derived_id('9e000000', s.company_id::text || s.reference),
  pg_temp.derived_id('9d000000', s.company_id::text || s.reference),
  s.code || '-' || s.reference || '-A1', 'answer',
  'Answered by management: ' || s.title || '. Supporting detail is filed in the '
  || 'data room under Financials; the diligence team has confirmed the figures '
  || 'tie to the trial balance.',
  pg_temp.client_id(),
  now() - (s.answered_days || ' days')::interval,
  pg_temp.derived_id('9e000000', s.company_id::text || s.reference), 1, true
FROM demo_qa_spec s
WHERE s.answered_days IS NOT NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO qa_assignees (id, item_id, user_id, kind, assigned_by)
SELECT
  pg_temp.derived_id('9f000000', s.company_id::text || s.reference),
  pg_temp.derived_id('9d000000', s.company_id::text || s.reference),
  pg_temp.client_id(), 'requestee', pg_temp.broker_id()
FROM demo_qa_spec s
ON CONFLICT (id) DO NOTHING;


-- ── activity feed ───────────────────────────────────────────────────────────
-- Every company had an empty activity screen. The feed is assembled from rows
-- that already exist, so what it shows agrees with what the other screens show
-- rather than being an independent work of fiction.
INSERT INTO activity_log (id, company_id, type, message, created_by, created_at)
SELECT pg_temp.derived_id('9a100000', d.id::text || 'upload'),
       d.company_id, 'upload'::activity_type,
       'Uploaded ' || d.name, d.uploaded_by, d.uploaded_at
FROM documents d WHERE d.company_id::text LIKE '90%'
ON CONFLICT (id) DO NOTHING;

INSERT INTO activity_log (id, company_id, type, message, created_by, created_at)
SELECT pg_temp.derived_id('9a100000', r.id::text || 'request'),
       r.company_id, 'request'::activity_type,
       'Requested "' || r.title || '"', r.created_by, r.created_at
FROM requests r WHERE r.company_id::text LIKE '90%'
ON CONFLICT (id) DO NOTHING;

INSERT INTO activity_log (id, company_id, type, message, created_by, created_at)
SELECT pg_temp.derived_id('9a100000', r.id::text || 'approved'),
       r.company_id, 'approved'::activity_type,
       'Marked "' || r.title || '" complete', pg_temp.broker_id(),
       r.created_at + interval '4 days'
FROM requests r WHERE r.company_id::text LIKE '90%' AND r.status = 'completed'
ON CONFLICT (id) DO NOTHING;

-- Acme and Northwind get a feed too. Their activity screen is one of the five
-- legacy-bridge routes up.sh checks, and it answered 200-with-nothing.
INSERT INTO activity_log (id, company_id, type, message, created_by, created_at)
SELECT pg_temp.derived_id('9a100000', d.id::text || 'upload'),
       d.company_id, 'upload'::activity_type,
       'Uploaded ' || d.name, d.uploaded_by, d.uploaded_at
FROM documents d
WHERE d.company_id IN ('a0000000-0000-4000-8000-000000000001',
                       'a0000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;

INSERT INTO activity_log (id, company_id, type, message, created_by, created_at)
SELECT pg_temp.derived_id('9a100000', r.id::text || 'request'),
       r.company_id, 'request'::activity_type,
       'Requested "' || r.title || '"', r.created_by, r.created_at
FROM requests r
WHERE r.company_id IN ('a0000000-0000-4000-8000-000000000001',
                       'a0000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;


-- ── reminders ───────────────────────────────────────────────────────────────
-- Chases against the requests that are actually outstanding, so the reminders
-- screen and the requests board tell the same story.
INSERT INTO reminders (id, company_id, request_id, title, message, due_date, priority,
                       frequency_days, sent_count, last_sent_at, next_due_at, status, created_by)
SELECT
  pg_temp.derived_id('9b100000', r.id::text),
  r.company_id, r.id,
  'Chase: ' || r.title,
  'Second follow-up sent to the seller. No response since the initial request.',
  r.due_date, CASE r.priority WHEN 'critical' THEN 'high' ELSE r.priority::text END,
  2, 2, now() - interval '2 days', now() + interval '1 day',
  'active'::reminder_status, pg_temp.broker_id()
FROM requests r
WHERE r.company_id::text LIKE '90%' AND r.status IN ('pending', 'in-review', 'blocked')
ON CONFLICT (id) DO NOTHING;

-- Closed-out chases, so the reminders screen has a completed state to show.
INSERT INTO reminders (id, company_id, request_id, title, message, due_date, priority,
                       frequency_days, sent_count, last_sent_at, status, created_by)
SELECT
  pg_temp.derived_id('9b100000', r.id::text || 'done'),
  r.company_id, r.id, 'Chase: ' || r.title,
  'Resolved — the seller uploaded the file and the request was closed.',
  r.due_date, 'medium', 2, 1, now() - interval '9 days',
  'done'::reminder_status, pg_temp.broker_id()
FROM requests r
WHERE r.company_id::text LIKE '90%' AND r.status = 'completed'
ON CONFLICT (id) DO NOTHING;

-- Acme's reminders screen is a legacy-bridge route up.sh checks; it was empty.
INSERT INTO reminders (id, company_id, request_id, title, message, due_date, priority,
                       frequency_days, sent_count, last_sent_at, next_due_at, status, created_by)
SELECT
  pg_temp.derived_id('9b100000', r.id::text),
  r.company_id, r.id, 'Chase: ' || r.title,
  'Follow-up sent to the seller ahead of the due date.',
  r.due_date, 'medium', 2, 1, now() - interval '3 days', now() + interval '2 days',
  'active'::reminder_status, pg_temp.broker_id()
FROM requests r
WHERE r.company_id = 'a0000000-0000-4000-8000-000000000001'
  AND r.status IN ('pending', 'in-review')
ON CONFLICT (id) DO NOTHING;


-- ── messages ────────────────────────────────────────────────────────────────
-- MESSAGES_MODULE_ENABLED is on and every thread was empty.
INSERT INTO message_groups (id, company_id, name, group_type, buyer_user_id, auto_created)
SELECT pg_temp.derived_id('9c100000', c.id::text || 'deal'), c.id,
       'Deal team — ' || c.name, 'deal_team', NULL, false
FROM companies c WHERE c.id::text LIKE '90%'
ON CONFLICT (id) DO NOTHING;

INSERT INTO message_groups (id, company_id, name, group_type, buyer_user_id, auto_created)
SELECT pg_temp.derived_id('9c100000', c.id::text || 'internal'), c.id,
       'Broker internal — ' || c.name, 'broker_internal', NULL, false
FROM companies c WHERE c.id::text LIKE '90%'
ON CONFLICT (id) DO NOTHING;

INSERT INTO message_group_members (group_id, user_id)
SELECT pg_temp.derived_id('9c100000', u.company_id::text || 'deal'), u.user_id
FROM user_companies u WHERE u.company_id::text LIKE '90%'
ON CONFLICT DO NOTHING;

-- The internal group is brokers and admins only — the point of it being separate.
INSERT INTO message_group_members (group_id, user_id)
SELECT pg_temp.derived_id('9c100000', u.company_id::text || 'internal'), u.user_id
FROM user_companies u
JOIN users usr ON usr.id = u.user_id AND usr.role IN ('broker', 'admin')
WHERE u.company_id::text LIKE '90%'
ON CONFLICT DO NOTHING;

INSERT INTO group_messages (id, group_id, sender_id, body, created_at)
SELECT
  pg_temp.derived_id('9d100000', c.id::text || v.tag),
  pg_temp.derived_id('9c100000', c.id::text || 'deal'),
  CASE v.who WHEN 'broker' THEN pg_temp.broker_id() ELSE pg_temp.client_id() END,
  v.body, now() - (v.age || ' hours')::interval
FROM companies c
CROSS JOIN (VALUES
  ('g1','broker','Kicking off diligence. The request list is live on the board — start with the audited financials.', 96),
  ('g2','client','Understood. Audits are with our accountant, should be up tomorrow.', 88),
  ('g3','broker','Thanks. The AR ageing is the one holding up the QoE bridge.', 60),
  ('g4','client','Uploaded the ageing just now under Financials.', 30),
  ('g5','broker','Got it — reviewing today and I will flag anything in Q&A.', 20)
) AS v(tag, who, body, age)
WHERE c.id::text LIKE '90%'
ON CONFLICT (id) DO NOTHING;

INSERT INTO group_messages (id, group_id, sender_id, body, created_at)
SELECT
  pg_temp.derived_id('9d100000', c.id::text || 'i1'),
  pg_temp.derived_id('9c100000', c.id::text || 'internal'),
  pg_temp.broker_id(),
  'Internal: hold the Contracts folder back until the LOI is signed.',
  now() - interval '40 hours'
FROM companies c WHERE c.id::text LIKE '90%'
ON CONFLICT (id) DO NOTHING;

INSERT INTO company_messages (id, company_id, sender_id, body, created_at)
SELECT
  pg_temp.derived_id('9e100000', c.id::text || v.tag),
  c.id,
  CASE v.who WHEN 'broker' THEN pg_temp.broker_id() ELSE pg_temp.client_id() END,
  v.body, now() - (v.age || ' hours')::interval
FROM companies c
CROSS JOIN (VALUES
  ('c1','broker','Welcome to the data room. Everything we need is on the requests board.', 120),
  ('c2','client','Thanks — we will work through it this week.', 110),
  ('c3','broker','One note: please do not remove documents once uploaded, version them instead.', 48)
) AS v(tag, who, body, age)
WHERE c.id::text LIKE '90%'
ON CONFLICT (id) DO NOTHING;

INSERT INTO direct_messages (id, company_id, sender_id, recipient_id, body, created_at)
SELECT
  pg_temp.derived_id('9f100000', c.id::text || v.tag),
  c.id, pg_temp.broker_id(), pg_temp.client_id(), v.body,
  now() - (v.age || ' hours')::interval
FROM companies c
CROSS JOIN (VALUES
  ('d1','Quick one — is the equipment appraisal something you already have?', 26),
  ('d2','If not I can commission it, but it adds about two weeks.', 25)
) AS v(tag, body, age)
WHERE c.id::text LIKE '90%'
ON CONFLICT (id) DO NOTHING;


-- ── file references ─────────────────────────────────────────────────────────
-- Documents claimed by another module. This is also the table folder deletion
-- checks, so a folder holding a referenced document is correctly undeletable —
-- the behaviour fixed in 36d87da, now with data behind it.
INSERT INTO file_references (id, company_id, document_id, linked_module, linked_entity_id, metadata, created_by)
SELECT
  pg_temp.derived_id('9a200000', d.id::text),
  d.company_id, d.id, 'key_reports', NULL,
  jsonb_build_object('report', 'Trial Balance', 'period', 'FY2025'),
  pg_temp.broker_id()
FROM documents d
WHERE d.company_id::text LIKE '90%' AND d.name = 'Trial Balance FY2025.txt'
ON CONFLICT (id) DO NOTHING;


-- ── user preferences ────────────────────────────────────────────────────────
INSERT INTO user_preferences (id, user_id, pref_key, pref_value)
SELECT pg_temp.derived_id('9b200000', u.id::text || v.k), u.id, v.k, v.val::jsonb
FROM users u
CROSS JOIN (VALUES
  ('dashboard.defaultView', '"portfolio"'),
  ('requests.sort',         '"due_date_asc"'),
  ('notifications.email',   'true')
) AS v(k, val)
WHERE u.id::text LIKE '91%' OR u.id::text LIKE 'b0%'
ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS demo_doc_spec;
DROP TABLE IF EXISTS demo_request_spec;
DROP TABLE IF EXISTS demo_qa_spec;

COMMIT;
