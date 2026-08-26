-- Northwind Logistics: a full, populated deal.
--
-- The base seed gives Northwind two folders and one document, so every screen a
-- visitor reaches on it is either empty or nearly so. This file makes it the
-- second fully-furnished mandate alongside Acme.
--
-- Northwind is a0..0002 — inside the ORIG range whose exact counts up.sh and
-- reset.sh assert — so those assertions move when this file lands. See the
-- counts updated alongside it.
--
-- Reserved id space: the `8x` prefix. Older seeds use a0/a1/b0/c0/d0/d1/e0/f0
-- and the breadth seed owns all of `9x`.
--
-- Idempotent: derived ids and ON CONFLICT throughout, so it re-runs against a
-- live stack without duplicating.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.nw_id(prefix text, key text)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT (prefix || '-0000-4000-8000-' || substr(md5(key), 1, 12))::uuid;
$$;

CREATE OR REPLACE FUNCTION pg_temp.nw() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'a0000000-0000-4000-8000-000000000002'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.admin_id() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'b0000000-0000-4000-8000-000000000001'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.broker_id() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'b0000000-0000-4000-8000-000000000002'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.client_id() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'b0000000-0000-4000-8000-000000000003'::uuid $$;

-- Existing people, reused rather than invented, so everyone named below can
-- actually sign in without a second Better Auth backfill pass.
-- 91..01 Rosa Marquez (broker), 91..03 Elena Fischer (analyst),
-- 91..07 Grace Lin (seller), 91..08 Tom Reyes (seller), 91..05 Priya Nair (buyer),
-- 91..0a Ingrid Sole (buyer), 91..0c Nadia Rahman (buyer).
CREATE OR REPLACE FUNCTION pg_temp.rosa()  RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-000000000001'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.elena() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-000000000003'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.tom()   RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-000000000008'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.priya() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-000000000005'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.ingrid() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-00000000000a'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.nadia() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-00000000000c'::uuid $$;


-- ── the company record ──────────────────────────────────────────────────────
-- Northwind had no project name, phone or start date; every other mandate does,
-- so its card read as the unfinished one on the portfolio screen.
UPDATE companies SET
  project_name = 'Project Compass',
  contact_phone = '+1 206 555 0127',
  since = DATE '2026-01-19',
  industry = 'Freight & Logistics'
WHERE id = pg_temp.nw();


-- ── who works this deal ─────────────────────────────────────────────────────
INSERT INTO user_companies (user_id, company_id)
SELECT u, pg_temp.nw() FROM (VALUES
  (pg_temp.rosa()), (pg_temp.elena()), (pg_temp.tom()),
  (pg_temp.priya()), (pg_temp.ingrid()), (pg_temp.nadia())
) AS v(u)
ON CONFLICT DO NOTHING;


-- ── folder tree ─────────────────────────────────────────────────────────────
-- Northwind already has five top-level folders: Financials and Legal from the
-- base seed, Operations, Tax and Contracts from the breadth seed. Those are
-- reused as parents rather than recreated — `folders_company_parent_name_uq`
-- forbids a second folder of the same name under the same parent, and two
-- folders called "Operations" is the kind of detail a visitor notices anyway.
--
-- Every insert below uses a bare ON CONFLICT DO NOTHING rather than naming `id`:
-- the collision that matters here is on (company, parent, name), not the id.
INSERT INTO folders (id, company_id, name, parent_id, created_by, created_at)
SELECT pg_temp.nw_id('82000000', v.name), pg_temp.nw(), v.name, NULL,
       pg_temp.broker_id(), now() - (v.age || ' days')::interval
FROM (VALUES
  ('Commercial', 58), ('HR', 55), ('Insurance & Risk', 50),
  ('IT & Systems', 47), ('Environmental', 44)
) AS v(name, age)
ON CONFLICT DO NOTHING;

-- Parents resolved by name against whatever is actually there, so this does not
-- depend on which seed created the top level or what id it chose.
INSERT INTO folders (id, company_id, name, parent_id, created_by, created_at)
SELECT pg_temp.nw_id('82000000', v.parent || '/' || v.name), pg_temp.nw(), v.name,
       (SELECT p.id FROM folders p
         WHERE p.company_id = pg_temp.nw() AND p.name = v.parent AND p.parent_id IS NULL),
       pg_temp.broker_id(), now() - (v.age || ' days')::interval
FROM (VALUES
  ('Financials', 'Monthly Close',        42),
  ('Financials', 'Bank Statements',      41),
  ('Financials', 'Audit Workpapers',     40),
  ('Legal',      'Corporate Records',    39),
  ('Legal',      'Customer Contracts',   38),
  ('Legal',      'Carrier Agreements',   37),
  ('Operations', 'Fleet & Equipment',    36),
  ('Operations', 'Terminals & Leases',   35),
  ('Operations', 'Safety & Compliance',  34),
  ('Commercial', 'Customer Concentration', 33),
  ('Commercial', 'Pricing & Tariffs',    32)
) AS v(parent, name, age)
ON CONFLICT DO NOTHING;

-- An archived folder, so Northwind's archive filter has something to hide too.
INSERT INTO folders (id, company_id, name, parent_id, created_by, archived_at)
VALUES (pg_temp.nw_id('82000000', 'Superseded — 2024 Round'), pg_temp.nw(),
        'Superseded — 2024 Round', NULL, pg_temp.broker_id(), now() - interval '20 days')
ON CONFLICT DO NOTHING;


-- ── documents, with real bytes ──────────────────────────────────────────────
CREATE TEMP TABLE nw_doc_spec AS
SELECT * FROM (VALUES
  ('Financials/Monthly Close',   'Close Package Jun 2026.txt', E'Northwind Logistics — month-end close package\nPeriod: June 2026\nRevenue 4,182,660 | Gross margin 31.4% | Operating ratio 0.92\nPrepared by M. Devlin, reviewed by external accountant.', 24, 'verified',     2, 'client'),
  ('Financials/Monthly Close',   'Close Package May 2026.txt', E'Northwind Logistics — month-end close package\nPeriod: May 2026\nRevenue 3,948,201 | Gross margin 30.8% | Operating ratio 0.94', 52, 'verified',     1, 'client'),
  ('Financials/Bank Statements', 'Operating Account Jun 2026.txt', E'Cascade Commercial Bank — operating account 4471\nJune 2026. Opening 812,440.19 | Closing 968,113.55\n214 deposits, 388 disbursements.', 23, 'verified',  1, 'client'),
  ('Financials/Bank Statements', 'Fuel Card Account Jun 2026.txt', E'Fleet fuel card settlement — June 2026\n41 vehicles, 18,904 gallons, 71,220.14 settled.', 22, 'verified', 1, 'client'),
  ('Financials/Audit Workpapers','Revenue Recognition Memo.txt', E'Revenue recognition — memo to file\nFreight revenue is recognised over time as the shipment moves.\nIn-transit at period end is estimated from the dispatch system.', 38, 'under-review', 3, 'broker'),
  ('Financials',                 'Trial Balance FY2025.txt',    E'Northwind Logistics — trial balance FY2025 (unaudited)\nTotal debits 18,443,209.11 | Total credits 18,443,209.11', 46, 'verified', 2, 'broker'),
  ('Financials',                 'SDE Bridge FY2023-FY2025.txt',E'Seller''s discretionary earnings bridge\nFY2025 reported EBITDA 1,284,300\n+ owner compensation 310,000\n+ personal vehicle & travel 41,800\n+ non-recurring legal 96,400\n= SDE 1,732,500', 20, 'under-review', 2, 'broker'),
  ('Legal/Corporate Records',    'Articles of Incorporation.txt', E'Northwind Logistics Inc. — articles of incorporation\nIncorporated Washington State, 2009-04-14. Amended 2017-08-02.', 61, 'verified', 1, 'broker'),
  ('Legal/Corporate Records',    'Cap Table 2026.txt',          E'Capitalisation table as at 2026-06-30\nS. Owner 74.5% | R. Okafor 12.0% | M. Devlin 8.5% | ESOP pool 5.0%', 44, 'verified', 2, 'broker'),
  ('Legal/Customer Contracts',   'Master Services — Cascade Grocers.txt', E'Master services agreement — Cascade Grocers Co-op\nEffective 2023-02-01, auto-renews annually. 90-day termination for convenience.\nCHANGE OF CONTROL: consent required (clause 19.3).', 36, 'under-review', 1, 'broker'),
  ('Legal/Customer Contracts',   'Master Services — Pacific Foods.txt', E'Master services agreement — Pacific Foods Distribution\nEffective 2024-06-15, three-year initial term.\nVolume commitment 4,200 loads/yr with shortfall rebate.', 35, 'verified', 1, 'broker'),
  ('Legal/Carrier Agreements',   'Owner-Operator Agreement Template.txt', E'Owner-operator agreement — standard form\n38 active owner-operators on this form. Classification reviewed by counsel 2025-11.', 33, 'under-review', 1, 'broker'),
  ('Legal',                      'Litigation Summary 2026.txt', E'Open and threatened matters as at 2026-06-30\n1. Ramirez v. Northwind — employment, mediation scheduled, reserve 85,000\n2. Cargo claim, Pacific Foods load 88214 — 22,400, insured above 25,000 deductible', 18, 'under-review', 1, 'broker'),
  ('Operations/Fleet & Equipment','Fleet Schedule 2026.txt',    E'Fleet schedule — 41 power units, 96 trailers\nAverage tractor age 4.2 yrs | 11 units financed, 30 owned outright\nReplacement capex forecast 1.4M over three years.', 30, 'verified', 3, 'client'),
  ('Operations/Fleet & Equipment','Maintenance Log Summary.txt', E'Preventive maintenance compliance — trailing 12 months\nOn-schedule 94.1% | Roadside inspections 62, out-of-service 3', 28, 'verified', 1, 'client'),
  ('Operations/Terminals & Leases','Kent Terminal Lease.txt',   E'Terminal lease — Kent, WA (main hub)\n62,000 sq ft cross-dock. Expires 2031-05-31, one 5-yr option.\nLandlord: Owner Family Holdings LLC — RELATED PARTY.', 31, 'under-review', 2, 'broker'),
  ('Operations/Terminals & Leases','Spokane Terminal Lease.txt',E'Terminal lease — Spokane, WA (satellite)\n18,000 sq ft. Expires 2027-09-30. Market rent, unrelated landlord.', 29, 'verified', 1, 'broker'),
  ('Operations/Safety & Compliance','DOT Safety Rating.txt',    E'FMCSA safety rating: SATISFACTORY (last audit 2025-03-11)\nCSA BASIC percentiles: Unsafe Driving 41 | HOS Compliance 28 | Vehicle Maint 55', 27, 'verified', 1, 'client'),
  ('Operations/Safety & Compliance','Driver Qualification Audit.txt', E'Driver qualification file audit — internal, 2026-Q2\n52 files reviewed, 3 missing current medical certificates, all remediated.', 25, 'under-review', 1, 'client'),
  ('Commercial/Customer Concentration','Top 20 Customers FY2025.txt', E'Revenue by customer, FY2025\n1. Cascade Grocers Co-op 3,914,200 (21.2%)\n2. Pacific Foods Distribution 2,880,410 (15.6%)\n3. Harborview Building Supply 1,406,880 (7.6%)\nTop 5 = 52.1% | Top 20 = 81.4%', 21, 'under-review', 2, 'broker'),
  ('Commercial/Pricing & Tariffs','Rate Card 2026.txt',         E'Published rate card — effective 2026-01-01\nDry van per-mile 2.41 | Reefer 2.94 | Fuel surcharge indexed weekly to DOE.', 26, 'verified', 1, 'broker'),
  ('Commercial',                 'Customer Churn Analysis.txt', E'Logo retention FY2023-FY2025\nGross revenue retention 91.4% | Net 103.8%\nTwo accounts lost in FY2025, both under 200k.', 19, 'under-review', 1, 'broker'),
  ('HR',                         'Employee Census.txt',        E'Headcount 118 as at 2026-06-30\nDrivers 52 | Owner-operators 38 | Dock 14 | Admin & dispatch 14\nVoluntary turnover 22.4% (industry 31%).', 32, 'verified', 1, 'client'),
  ('HR',                         'Benefits Summary 2026.txt',  E'Plan year 2026 — medical, dental, 401(k) with 3% safe harbour.\nEmployer cost 1,284/employee/month blended.', 30, 'verified', 1, 'client'),
  ('HR',                         'Retention Agreements.txt',   E'Change-of-control retention — 4 key employees\nDevlin, Okafor, dispatch manager, safety director.\nTriggers on sale, 6 months base, payable by buyer.', 17, 'under-review', 1, 'broker'),
  ('Tax',                        'Federal Return 2025.txt',    E'Form 1120S, tax year 2025, as filed 2026-03-14\nOrdinary business income 1,102,884. No open examinations.', 43, 'verified', 1, 'client'),
  ('Tax',                        'State Nexus Review.txt',     E'Filing obligations: WA, OR, ID, MT, CA\nCA registered 2024 after driver-domicile review. No prior-year exposure identified.', 16, 'under-review', 1, 'broker'),
  ('Insurance & Risk',           'Certificates of Insurance.txt', E'Auto liability 1M/occurrence | Cargo 250k | General liability 2M aggregate\nUmbrella 5M. Broker of record: Sound Risk Partners. Renews 2026-11-01.', 15, 'verified', 1, 'client'),
  ('Insurance & Risk',           'Loss Runs 2021-2026.txt',    E'Five-year loss runs — auto liability\n2021 4 claims 88k | 2022 6 claims 141k | 2023 3 claims 62k\n2024 5 claims 210k | 2025 2 claims 41k | 2026 YTD 1 claim 22k', 14, 'under-review', 1, 'client'),
  ('IT & Systems',               'Systems Inventory.txt',      E'TMS: McLeod PowerBroker (on-prem, v22.1)\nELD: Samsara | Accounting: Sage Intacct | EDI via SPS Commerce\nOne part-time IT contractor; no internal IT staff.', 13, 'under-review', 1, 'broker'),
  ('Environmental',              'Phase I ESA — Kent.txt',     E'Phase I environmental site assessment — Kent terminal\nCompleted 2025-08-19. No recognised environmental conditions.\nUnderground fuel tank removed 2011, closure letter on file.', 12, 'verified', 1, 'broker'),
  -- One rejected document, so Northwind's status filter has all three values.
  ('Superseded — 2024 Round',    'Draft CIM 2024 — DO NOT USE.txt', E'Superseded draft from the 2024 process.\nFigures predate the FY2025 restatement. Retained for audit trail only.', 11, 'rejected', 1, 'broker')
) AS v(folder_path, file_name, body, age_days, status, versions, owner);

-- Resolve each spec row's folder path to a real folder id by its leaf name.
-- Every leaf name above is unique within Northwind, so the lookup is
-- unambiguous, and resolving by name rather than by derived id means a folder
-- an earlier seed already created is found rather than missed.
CREATE TEMP TABLE nw_doc AS
SELECT s.*,
  (SELECT f.id FROM folders f
    WHERE f.company_id = pg_temp.nw()
      AND f.name = regexp_replace(s.folder_path, '^.*/', '')) AS folder_id,
  CASE s.owner WHEN 'broker' THEN pg_temp.broker_id() ELSE pg_temp.tom() END AS actor
FROM nw_doc_spec s;

-- A document with a null folder is invisible in the tree, so fail loudly here
-- rather than seeding rows nobody can reach by clicking.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(folder_path, ', ') INTO missing FROM nw_doc WHERE folder_id IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'unresolved folder paths: %', missing;
  END IF;
END $$;

INSERT INTO uploads (id, file_name, content_type, size_bytes, data, prefix, uploaded_by, created_at)
SELECT
  pg_temp.nw_id('84000000', d.file_name || g.n::text),
  d.file_name, 'text/plain',
  length(convert_to(d.body || E'\n\n[revision ' || g.n || ']', 'UTF8')),
  convert_to(d.body || E'\n\n[revision ' || g.n || ']', 'UTF8'),
  'documents', d.actor,
  now() - ((d.age_days - (g.n - 1) * 5) || ' days')::interval
FROM nw_doc d CROSS JOIN LATERAL generate_series(1, d.versions) AS g(n)
ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, size_bytes = EXCLUDED.size_bytes;

INSERT INTO documents (id, company_id, folder_id, name, file_url, upload_id, size, ext,
                       status, uploaded_by, uploaded_at, version_count)
SELECT
  pg_temp.nw_id('83000000', d.file_name),
  pg_temp.nw(), d.folder_id, d.file_name, '',
  pg_temp.nw_id('84000000', d.file_name || d.versions::text),
  length(convert_to(d.body || E'\n\n[revision ' || d.versions || ']', 'UTF8'))::text,
  'txt', d.status::document_status, d.actor,
  now() - (d.age_days || ' days')::interval,
  d.versions
FROM nw_doc d
ON CONFLICT (id) DO UPDATE SET
  upload_id = EXCLUDED.upload_id, version_count = EXCLUDED.version_count,
  status = EXCLUDED.status, folder_id = EXCLUDED.folder_id;

INSERT INTO document_versions (id, document_id, version_no, upload_id, file_name,
                               size_bytes, content_type, note, created_by, created_at)
SELECT
  pg_temp.nw_id('85000000', d.file_name || g.n::text),
  pg_temp.nw_id('83000000', d.file_name),
  g.n,
  pg_temp.nw_id('84000000', d.file_name || g.n::text),
  d.file_name,
  length(convert_to(d.body || E'\n\n[revision ' || g.n || ']', 'UTF8')),
  'text/plain',
  CASE g.n WHEN 1 THEN NULL
           WHEN 2 THEN 'Reissued after the FY2025 restatement'
           ELSE 'Updated following diligence questions' END,
  d.actor,
  now() - ((d.age_days - (g.n - 1) * 5) || ' days')::interval
FROM nw_doc d CROSS JOIN LATERAL generate_series(1, d.versions) AS g(n)
ON CONFLICT (id) DO NOTHING;

UPDATE documents doc SET current_version_id =
  pg_temp.nw_id('85000000', d.file_name || d.versions::text)
FROM nw_doc d
WHERE doc.id = pg_temp.nw_id('83000000', d.file_name);


-- ── document comments ───────────────────────────────────────────────────────
INSERT INTO document_comments (id, document_id, company_id, author_id, body, visibility, created_at)
SELECT pg_temp.nw_id('86000000', v.file || v.tag),
       pg_temp.nw_id('83000000', v.file), pg_temp.nw(),
       CASE v.who WHEN 'broker' THEN pg_temp.broker_id()
                  WHEN 'analyst' THEN pg_temp.elena() ELSE pg_temp.tom() END,
       v.body, v.visibility, now() - (v.age || ' hours')::interval
FROM (VALUES
  ('Kent Terminal Lease.txt', 'c1', 'internal', 'broker',
   'Related-party landlord. Rent is roughly 18% above the Kent submarket — the SDE bridge carries the excess as an add-back, so make sure the buyer sees both numbers.', 96),
  ('Kent Terminal Lease.txt', 'c2', 'shared', 'broker',
   'Please confirm whether the 5-year option is assignable on a change of control.', 70),
  ('Kent Terminal Lease.txt', 'c3', 'shared', 'seller',
   'Counsel says the option is assignable with landlord consent, not to be unreasonably withheld. Sending the estoppel this week.', 44),
  ('Top 20 Customers FY2025.txt', 'c4', 'internal', 'analyst',
   'Cascade at 21% is the single biggest diligence risk in this deal. Worth pre-empting with the retention history rather than waiting to be asked.', 66),
  ('Top 20 Customers FY2025.txt', 'c5', 'shared', 'broker',
   'v2 reflects the reclassified brokerage revenue — please work from this one.', 30),
  ('SDE Bridge FY2023-FY2025.txt', 'c6', 'internal', 'analyst',
   'Owner comp add-back of 310k assumes a 165k replacement GM salary. Flag it explicitly; buyers always test this line.', 52),
  ('Master Services — Cascade Grocers.txt', 'c7', 'internal', 'broker',
   'Clause 19.3 consent is the gating item for signing. Start the conversation with Cascade before we go to LOI.', 40),
  ('Litigation Summary 2026.txt', 'c8', 'shared', 'seller',
   'Ramirez mediation moved to the 14th. We expect it settles within the reserve.', 26),
  ('Owner-Operator Agreement Template.txt', 'c9', 'internal', 'analyst',
   'Worker classification is the tail risk here — 38 owner-operators on one template. Counsel reviewed in Nov 2025 but that memo is not in the room.', 18),
  ('Loss Runs 2021-2026.txt', 'c10', 'shared', 'broker',
   '2024 is the outlier year. The 210k is a single at-fault accident, since remediated with the driver-scorecard programme.', 12)
) AS v(file, tag, visibility, who, body, age)
ON CONFLICT (id) DO NOTHING;


-- ── views and downloads ─────────────────────────────────────────────────────
-- Populates "who has looked at this", which is empty on every company but Acme.
INSERT INTO document_activity (id, document_id, user_id, activity_type, created_at, actor_id, action, at)
SELECT pg_temp.nw_id('87000000', d.id::text || u.uid::text || v.kind),
       d.id, u.uid, v.kind::document_activity_type,
       now() - ((v.age + u.offset_h) || ' hours')::interval,
       u.uid, v.kind, now() - ((v.age + u.offset_h) || ' hours')::interval
FROM documents d
CROSS JOIN (VALUES ('view', 30), ('download', 26)) AS v(kind, age)
CROSS JOIN (VALUES
  (pg_temp.priya(), 0), (pg_temp.ingrid(), 5), (pg_temp.nadia(), 11)
) AS u(uid, offset_h)
WHERE d.company_id = pg_temp.nw()
ON CONFLICT (id) DO NOTHING;


-- ── buyer groups and folder grants ──────────────────────────────────────────
INSERT INTO buyer_groups (id, company_id, name, description)
VALUES
  (pg_temp.nw_id('89000000', 'r1'), pg_temp.nw(), 'Round 1 — IOI',
   'Bidders holding an indication of interest. Financials, Commercial and Legal only.'),
  (pg_temp.nw_id('89000000', 'r2'), pg_temp.nw(), 'Round 2 — LOI',
   'Shortlist under letter of intent. Full room including HR and Carrier Agreements.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO buyer_group_members (group_id, user_id)
VALUES
  (pg_temp.nw_id('89000000', 'r1'), pg_temp.priya()),
  (pg_temp.nw_id('89000000', 'r1'), pg_temp.ingrid()),
  (pg_temp.nw_id('89000000', 'r1'), pg_temp.nadia()),
  (pg_temp.nw_id('89000000', 'r2'), pg_temp.priya())
ON CONFLICT DO NOTHING;

-- Round 1 folders for everyone; the Round 2 shortlist also gets HR and carriers.
INSERT INTO folder_access (id, folder_id, user_id, can_read, can_write, can_download, created_by)
SELECT pg_temp.nw_id('88000000', f.id::text || u.uid::text),
       f.id, u.uid, true, false, true, pg_temp.broker_id()
FROM folders f
CROSS JOIN (VALUES (pg_temp.priya()), (pg_temp.ingrid()), (pg_temp.nadia())) AS u(uid)
WHERE f.company_id = pg_temp.nw()
  AND f.name IN ('Financials', 'Commercial', 'Legal', 'Operations', 'Tax')
ON CONFLICT (id) DO NOTHING;

INSERT INTO folder_access (id, folder_id, user_id, can_read, can_write, can_download, created_by)
SELECT pg_temp.nw_id('88000000', f.id::text || pg_temp.priya()::text),
       f.id, pg_temp.priya(), true, false, true, pg_temp.broker_id()
FROM folders f
WHERE f.company_id = pg_temp.nw()
  AND f.name IN ('HR', 'Carrier Agreements', 'Insurance & Risk')
ON CONFLICT (id) DO NOTHING;


-- ── requests board ──────────────────────────────────────────────────────────
CREATE TEMP TABLE nw_req AS
SELECT * FROM (VALUES
  ('Three years of audited financials', 'FY2023–FY2025', 'Signed audit opinions and full note disclosure for each of the last three fiscal years.', 'Finance', 'Upload', 'critical', 'completed', -24, 30),
  ('SDE bridge with supporting schedules', 'Owner add-backs', 'The discretionary earnings bridge with a supporting schedule behind every add-back over 25k.', 'Finance', 'Both', 'critical', 'in-review', -4, 22),
  ('Monthly close packages, trailing 24 months', NULL, 'Complete close package for each month, including the operating-ratio calculation.', 'Finance', 'Upload', 'high', 'completed', -18, 26),
  ('Aged receivables and bad-debt history', 'AR ageing', 'Aged debtor listing bucketed 30/60/90/120+, with write-offs by year.', 'Finance', 'Upload', 'high', 'in-review', -2, 15),
  ('Fuel surcharge recovery analysis', NULL, 'Surcharge billed versus fuel cost incurred, by month, for three years.', 'Finance', 'Both', 'medium', 'pending', 6, 9),
  ('Capital expenditure forecast', 'Fleet replacement', 'Three-year replacement schedule with assumed trade values and financing terms.', 'Finance', 'Narrative', 'medium', 'pending', 11, 7),
  ('Top 20 customer revenue by year', 'Concentration', 'Revenue and gross margin by customer for the top twenty, FY2023 through FY2025.', 'M&A', 'Upload', 'critical', 'completed', -12, 24),
  ('Customer contracts with change-of-control clauses', NULL, 'Every contract requiring consent or notice on a change of control, with the clause identified.', 'Legal', 'Upload', 'critical', 'in-review', -1, 19),
  ('Corporate structure and cap table', 'Legal entities', 'All entities, ownership percentages, jurisdictions, and any option or phantom equity.', 'Legal', 'Upload', 'medium', 'completed', -20, 28),
  ('Outstanding and threatened litigation', NULL, 'Any live or threatened claim above 25k, with counsel assessment and reserve.', 'Legal', 'Narrative', 'high', 'blocked', -5, 17),
  ('Owner-operator classification review', 'Counsel memo', 'The 2025 worker-classification memo and any remediation undertaken since.', 'Legal', 'Both', 'critical', 'blocked', 3, 13),
  ('Terminal leases, all locations', 'Including related party', 'Executed leases with amendments. Flag any related-party landlord and the rent basis.', 'Legal', 'Upload', 'high', 'completed', -15, 25),
  ('Employee census and turnover', 'Headcount', 'Role, tenure, location and compensation band for every employee, plus 3-year turnover.', 'HR', 'Upload', 'medium', 'completed', -9, 21),
  ('Change-of-control and retention arrangements', NULL, 'Describe every retention, bonus or change-of-control arrangement and whether a sale triggers it.', 'HR', 'Narrative', 'high', 'in-review', 2, 11),
  ('Driver qualification file audit', 'DOT compliance', 'Most recent internal audit of driver qualification files, with remediation status.', 'Compliance', 'Upload', 'high', 'pending', 8, 6),
  ('DOT safety rating and CSA scores', NULL, 'Current FMCSA rating, last audit report, and CSA BASIC percentiles by month.', 'Compliance', 'Upload', 'medium', 'completed', -7, 20),
  ('Five-year insurance loss runs', 'All lines', 'Loss runs for auto liability, cargo and workers compensation, five years each.', 'Compliance', 'Upload', 'high', 'in-review', -3, 14),
  ('State tax nexus and filing history', NULL, 'States with filing obligations, current standing, and any voluntary disclosure agreements.', 'Tax', 'Both', 'medium', 'pending', 14, 8),
  ('Federal and state returns, three years', 'As filed', 'Complete filed returns with all schedules and K-1s.', 'Tax', 'Upload', 'medium', 'completed', -16, 27),
  ('Phase I environmental, all sites', NULL, 'Phase I ESA for each terminal, plus any closure letters for removed tanks.', 'Other', 'Upload', 'low', 'completed', -11, 23),
  ('IT systems inventory and licence transferability', NULL, 'Every business system, its licence basis, and whether it transfers on a sale.', 'Other', 'Both', 'low', 'pending', 18, 5)
) AS v(title, sub_label, descr, category, response_type, priority, status, due_offset, age_days);

INSERT INTO requests (id, company_id, title, sub_label, description, category,
                      response_type, priority, status, due_date, assigned_to,
                      created_by, reminder_frequency_days, submission_source,
                      approval_status, approved_by, approved_at, created_at)
SELECT
  pg_temp.nw_id('8a000000', r.title),
  pg_temp.nw(), r.title, r.sub_label, r.descr,
  r.category::request_category, r.response_type::response_type,
  r.priority::request_priority, r.status::request_status,
  (now() + (r.due_offset || ' days')::interval)::date,
  pg_temp.tom(), pg_temp.broker_id(), 3, 'broker', 'approved',
  pg_temp.broker_id(), now() - (r.age_days || ' days')::interval,
  now() - (r.age_days || ' days')::interval
FROM nw_req r
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status, due_date = EXCLUDED.due_date, priority = EXCLUDED.priority;

-- Two seller-submitted items still awaiting broker approval.
INSERT INTO requests (id, company_id, title, sub_label, description, category,
                      response_type, priority, status, due_date, assigned_to,
                      created_by, submission_source, approval_status, created_at)
VALUES
  (pg_temp.nw_id('8a000000', 'seller-appraisal'), pg_temp.nw(),
   'Fleet appraisal (seller submitted)', 'Awaiting approval',
   'Third-party appraisal of the tractor and trailer fleet, commissioned by the seller ahead of the request.',
   'Finance'::request_category, 'Upload'::response_type, 'medium'::request_priority,
   'pending'::request_status, (now() + interval '9 days')::date,
   pg_temp.tom(), pg_temp.tom(), 'seller', 'pending', now() - interval '3 days'),
  (pg_temp.nw_id('8a000000', 'seller-esop'), pg_temp.nw(),
   'ESOP pool treatment on sale (seller submitted)', 'Awaiting approval',
   'Seller asks how the 5% ESOP pool is treated in the purchase price allocation.',
   'M&A'::request_category, 'Narrative'::response_type, 'high'::request_priority,
   'pending'::request_status, (now() + interval '4 days')::date,
   pg_temp.broker_id(), pg_temp.tom(), 'seller', 'pending', now() - interval '1 day')
ON CONFLICT (id) DO UPDATE SET approval_status = EXCLUDED.approval_status;

INSERT INTO request_narratives (id, request_id, content, updated_by, updated_at)
SELECT pg_temp.nw_id('8b000000', v.title), pg_temp.nw_id('8a000000', v.title),
       v.content, pg_temp.tom(), now() - (v.age || ' days')::interval
FROM (VALUES
  ('Outstanding and threatened litigation',
   'Two matters are open. Ramirez v. Northwind is an employment claim from a former dispatcher, in mediation with a reserve of 85,000 and counsel assessing settlement as likely within reserve. A cargo claim on Pacific Foods load 88214 is valued at 22,400, below the 25,000 policy deductible and therefore uninsured. No other claim above the threshold is live or, to management''s knowledge, threatened.', 4),
  ('Change-of-control and retention arrangements',
   'Four employees hold retention agreements triggered by a change of control: the CFO, the VP of Operations, the dispatch manager and the safety director. Each provides six months of base salary payable by the buyer, contingent on remaining employed for twelve months post-close. No arrangement accelerates equity, and the ESOP pool is unaffected.', 3),
  ('Owner-operator classification review',
   'Counsel reviewed the owner-operator model in November 2025 and concluded the current agreement is defensible under Washington law, with two recommendations since implemented: removal of the exclusivity provision and a written statement of the operator''s right to refuse loads. The memo itself is privileged and will be made available under a common-interest agreement after LOI.', 2),
  ('Capital expenditure forecast',
   'Replacement capex is forecast at 1.4M over three years, covering eleven tractors reaching 700,000 miles. Nine are expected to be financed at prevailing rates and two purchased outright from operating cash. No terminal or facility capex is planned beyond routine maintenance.', 6),
  ('Fuel surcharge recovery analysis',
   'Surcharge is indexed weekly to the DOE national average and has recovered between 91% and 104% of incremental fuel cost by month over the last three years, averaging 97.2%. The shortfall concentrates in weeks where the index lags a sharp price rise.', 5)
) AS v(title, content, age)
ON CONFLICT (id) DO NOTHING;

-- Requests answered with documents already in the room.
INSERT INTO request_documents (id, request_id, document_id, visible, created_at)
SELECT pg_temp.nw_id('8c000000', v.req || v.doc),
       pg_temp.nw_id('8a000000', v.req), pg_temp.nw_id('83000000', v.doc),
       true, now() - (v.age || ' days')::interval
FROM (VALUES
  ('Top 20 customer revenue by year', 'Top 20 Customers FY2025.txt', 10),
  ('Terminal leases, all locations', 'Kent Terminal Lease.txt', 14),
  ('Terminal leases, all locations', 'Spokane Terminal Lease.txt', 14),
  ('Employee census and turnover', 'Employee Census.txt', 8),
  ('Corporate structure and cap table', 'Cap Table 2026.txt', 19),
  ('DOT safety rating and CSA scores', 'DOT Safety Rating.txt', 6),
  ('Five-year insurance loss runs', 'Loss Runs 2021-2026.txt', 3),
  ('Federal and state returns, three years', 'Federal Return 2025.txt', 15),
  ('Phase I environmental, all sites', 'Phase I ESA — Kent.txt', 10),
  ('Customer contracts with change-of-control clauses', 'Master Services — Cascade Grocers.txt', 2),
  ('SDE bridge with supporting schedules', 'SDE Bridge FY2023-FY2025.txt', 4),
  ('Three years of audited financials', 'Trial Balance FY2025.txt', 22),
  ('Monthly close packages, trailing 24 months', 'Close Package Jun 2026.txt', 17),
  ('Change-of-control and retention arrangements', 'Retention Agreements.txt', 5),
  ('Owner-operator classification review', 'Owner-Operator Agreement Template.txt', 9)
) AS v(req, doc, age)
ON CONFLICT (id) DO NOTHING;

INSERT INTO request_reminders (id, request_id, sent_by, sent_at)
SELECT pg_temp.nw_id('8d000000', r.title || v.n::text),
       pg_temp.nw_id('8a000000', r.title), pg_temp.broker_id(),
       now() - ((v.n * 4) || ' days')::interval
FROM nw_req r CROSS JOIN (VALUES (1), (2)) AS v(n)
WHERE r.status IN ('pending', 'blocked', 'in-review')
ON CONFLICT (id) DO NOTHING;


-- ── reminders ───────────────────────────────────────────────────────────────
INSERT INTO reminders (id, company_id, request_id, title, message, due_date, priority,
                       frequency_days, sent_count, last_sent_at, next_due_at, status, created_by)
SELECT pg_temp.nw_id('8b100000', r.id::text), pg_temp.nw(), r.id,
       'Chase: ' || r.title,
       'Follow-up sent to the seller. Outstanding since the original request date.',
       r.due_date,
       CASE r.priority::text WHEN 'critical' THEN 'high' ELSE r.priority::text END,
       3, 2, now() - interval '2 days', now() + interval '1 day',
       'active'::reminder_status, pg_temp.broker_id()
FROM requests r
WHERE r.company_id = pg_temp.nw() AND r.status IN ('pending', 'in-review', 'blocked')
ON CONFLICT (id) DO NOTHING;

INSERT INTO reminders (id, company_id, request_id, title, message, due_date, priority,
                       frequency_days, sent_count, last_sent_at, status, created_by)
SELECT pg_temp.nw_id('8b100000', r.id::text || 'done'), pg_temp.nw(), r.id,
       'Chase: ' || r.title,
       'Resolved — the seller uploaded the file and the request was closed.',
       r.due_date, 'medium', 3, 1, now() - interval '11 days',
       'done'::reminder_status, pg_temp.broker_id()
FROM requests r
WHERE r.company_id = pg_temp.nw() AND r.status = 'completed'
ON CONFLICT (id) DO NOTHING;


-- ── Q&A ─────────────────────────────────────────────────────────────────────
-- citation_ref carries a GLOBAL unique index, so every reference is NWL-prefixed.
CREATE TEMP TABLE nw_qa AS
SELECT * FROM (VALUES
  ('finance', 'QA-201', 'Operating ratio trend', 'The operating ratio moved from 0.94 to 0.92 across FY2025. Is that rate, density, or cost control?', 'answered', 'high', 'QE', 'Revenue', 22, 18),
  ('finance', 'QA-202', 'Fuel surcharge recovery', 'What proportion of incremental fuel cost has the surcharge actually recovered, by year?', 'answered', 'high', 'QE', 'Cost of Revenue', 21, 16),
  ('finance', 'QA-203', 'Owner compensation add-back', 'The SDE bridge adds back 310k of owner compensation. What replacement salary is assumed, and on what basis?', 'answered', 'critical', 'QE', 'Add-backs', 19, 12),
  ('finance', 'QA-204', 'Related-party rent', 'The Kent terminal is leased from an entity controlled by the owner. What is the market rent, and who assessed it?', 'answered', 'critical', 'QE', 'Add-backs', 18, 9),
  ('finance', 'QA-205', 'Working capital seasonality', 'Describe the intra-year working capital swing and the peak funding requirement.', 'open', 'medium', 'QE', 'Working Capital', 12, NULL),
  ('finance', 'QA-206', 'Bad debt history', 'Write-offs by year for three years, and the current allowance basis.', 'open', 'medium', 'QE', 'Working Capital', 9, NULL),
  ('legal', 'QA-207', 'Change of control consents', 'Which customer contracts require consent on a change of control, and what is the expected timeline to obtain them?', 'answered', 'critical', 'Legal', 'Contracts', 17, 7),
  ('legal', 'QA-208', 'Owner-operator classification', 'What is the exposure if the owner-operator population were reclassified as employees?', 'open', 'critical', 'Legal', 'Contracts', 8, NULL),
  ('legal', 'QA-209', 'Litigation reserves', 'Are the reserves on the two open matters set on counsel advice, and are they insured?', 'answered', 'high', 'Legal', 'Litigation', 14, 6),
  ('compliance', 'QA-210', 'DOT safety rating durability', 'The CSA vehicle-maintenance percentile is 55. What is being done to bring it down before an audit?', 'open', 'high', 'Compliance', 'Permits', 7, NULL),
  ('compliance', 'QA-211', 'Insurance renewal exposure', 'The policy renews 2026-11-01. What premium movement is expected given the 2024 loss year?', 'open', 'medium', 'Compliance', 'Permits', 5, NULL),
  ('hr', 'QA-212', 'Driver turnover', 'Voluntary turnover is 22.4% against an industry 31%. What drives the outperformance, and is it durable post-sale?', 'answered', 'high', 'HR', 'People', 13, 4),
  ('hr', 'QA-213', 'Key person dependency', 'How dependent is the business on the founder day to day, and what transition is contemplated?', 'open', 'critical', 'HR', 'People', 6, NULL),
  ('tax', 'QA-214', 'California nexus exposure', 'California was registered in 2024 after a driver-domicile review. Is there prior-year exposure?', 'answered', 'medium', 'Tax', 'Credits', 11, 3),
  ('ma', 'QA-215', 'ESOP treatment on sale', 'How is the 5% ESOP pool treated in the purchase price allocation?', 'open', 'high', 'M&A', 'Structure', 4, NULL),
  ('other', 'QA-216', 'TMS licence transferability', 'Does the McLeod licence transfer on a change of control, or is a new licence required?', 'closed', 'low', 'Other', 'Systems', 10, 8)
) AS v(cat_key, reference, title, body, status, priority, module_tag, section_tag, asked_days, answered_days);

INSERT INTO qa_items (id, company_id, category_id, reference, title, body, status,
                      priority, origin, module_tag, section_tag, requestor_id,
                      created_by, asked_at, answered_at, closed_at, due_date)
SELECT
  pg_temp.nw_id('8e000000', q.reference),
  pg_temp.nw(),
  (SELECT id FROM qa_categories c WHERE c.company_id = pg_temp.nw() AND c.key = q.cat_key),
  'NWL-' || q.reference, q.title, q.body, q.status, q.priority, 'manual',
  q.module_tag, q.section_tag,
  CASE q.module_tag WHEN 'QE' THEN pg_temp.elena() ELSE pg_temp.broker_id() END,
  pg_temp.broker_id(),
  now() - (q.asked_days || ' days')::interval,
  CASE WHEN q.answered_days IS NULL THEN NULL ELSE now() - (q.answered_days || ' days')::interval END,
  CASE WHEN q.status = 'closed' THEN now() - interval '6 days' ELSE NULL END,
  (now() + interval '10 days')::date
FROM nw_qa q
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, answered_at = EXCLUDED.answered_at;

INSERT INTO qa_responses (id, item_id, citation_ref, kind, body, author_id, posted_at,
                          answer_root_id, answer_version, is_current)
SELECT
  pg_temp.nw_id('8f000000', q.reference),
  pg_temp.nw_id('8e000000', q.reference),
  'NWL-' || q.reference || '-A1', 'answer',
  CASE q.reference
    WHEN 'QA-201' THEN 'Roughly two thirds rate and one third density. Contract rates rose 4.1% on renewal across the top ten accounts, and the Spokane lane pairing added backhaul volume that cut empty miles from 14.2% to 11.8%. Cost control contributed the balance, mainly maintenance.'
    WHEN 'QA-202' THEN 'Recovery has averaged 97.2% over three years, ranging 91% to 104% by month. The shortfall concentrates in weeks where the DOE index lags a sharp price rise; the surcharge resets weekly, so the gap closes within two weeks in every observed instance.'
    WHEN 'QA-203' THEN 'The bridge assumes a replacement general manager at 165,000 base plus 15% bonus, benchmarked against two regional carrier searches run in 2025. The 310,000 add-back is the excess of actual owner compensation over that figure, inclusive of payroll taxes.'
    WHEN 'QA-204' THEN 'Contract rent is 18% above the Kent submarket. A third-party broker opinion of value dated March 2026 put market at 11.40 per square foot against 13.45 contracted; the SDE bridge carries the excess as a related-party add-back and the opinion is filed under Operations.'
    WHEN 'QA-207' THEN 'Two contracts require consent: Cascade Grocers under clause 19.3 and Harborview Building Supply under its schedule 4. Pacific Foods requires notice only. Counsel expects both consents inside four weeks once the buyer is identified; neither counterparty has a history of withholding.'
    WHEN 'QA-209' THEN 'Both reserves are set on outside counsel advice. Ramirez is uninsured as an employment matter below the EPLI retention; the cargo claim sits below the 25,000 policy deductible and is therefore also uninsured. Combined exposure is capped at approximately 107,000.'
    WHEN 'QA-212' THEN 'Three factors: guaranteed home time on the regional lanes, a driver-scorecard bonus introduced in 2023, and equipment age below the regional average. All three are operating practices rather than founder relationships, so they survive a sale.'
    WHEN 'QA-214' THEN 'No prior-year exposure identified. The review concluded that pre-2024 activity did not create nexus because no driver was domiciled in California and deliveries were interstate through-freight. A voluntary disclosure agreement was considered and judged unnecessary.'
    WHEN 'QA-216' THEN 'The McLeod licence is assignable with vendor consent, which McLeod has confirmed in writing is granted as a matter of course on a change of control provided the annual maintenance is current. It is.'
    ELSE 'Answered by management. Supporting detail is filed in the data room.'
  END,
  pg_temp.tom(),
  now() - (q.answered_days || ' days')::interval,
  pg_temp.nw_id('8f000000', q.reference), 1,
  -- QA-203 is superseded below, so its v1 is not the current answer.
  CASE WHEN q.reference = 'QA-203' THEN false ELSE true END
FROM nw_qa q
WHERE q.answered_days IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- A revised answer that supersedes its first version: the same story Acme tells,
-- so the version control on answers is demonstrable on either company.
INSERT INTO qa_responses (id, item_id, citation_ref, kind, body, author_id, posted_at,
                          supersedes_id, answer_root_id, answer_version, is_current)
VALUES (
  pg_temp.nw_id('8f000000', 'QA-203-v2'),
  pg_temp.nw_id('8e000000', 'QA-203'),
  'NWL-QA-203-A2', 'answer',
  'Revised after the buyer questioned the benchmark. The replacement general manager is now assumed at 185,000 base plus 15% bonus, reflecting the two regional carrier searches plus a third data point from a 2026 recruiter estimate. The owner compensation add-back reduces from 310,000 to 287,000 accordingly, and the SDE bridge has been reissued as v2.',
  pg_temp.tom(), now() - interval '5 days',
  pg_temp.nw_id('8f000000', 'QA-203'),
  pg_temp.nw_id('8f000000', 'QA-203'), 2, true
) ON CONFLICT (id) DO NOTHING;

-- A broker rewording, published for buyer consumption beside the raw answer.
INSERT INTO qa_presentations (id, item_id, source_response_id, body, version, is_current, status, author_id, created_at)
VALUES (
  pg_temp.nw_id('8f000000', 'pres-203'),
  pg_temp.nw_id('8e000000', 'QA-203'),
  pg_temp.nw_id('8f000000', 'QA-203-v2'),
  'Owner compensation is added back at 287,000, being the excess of actual compensation over a benchmarked replacement general manager package of 185,000 base plus 15% bonus. The benchmark is supported by two 2025 regional carrier searches and a 2026 recruiter estimate.',
  1, true, 'published', pg_temp.broker_id(), now() - interval '4 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO qa_assignees (id, item_id, user_id, kind, assigned_by)
SELECT pg_temp.nw_id('8f100000', q.reference),
       pg_temp.nw_id('8e000000', q.reference), pg_temp.tom(), 'requestee', pg_temp.broker_id()
FROM nw_qa q
ON CONFLICT (id) DO NOTHING;

-- Category nominees: who on the seller side owns each subject area.
INSERT INTO qa_nominations (id, company_id, category_id, user_id, nominated_by)
SELECT pg_temp.nw_id('8f200000', c.key), pg_temp.nw(), c.id,
       CASE WHEN c.key IN ('finance', 'tax') THEN pg_temp.tom() ELSE pg_temp.elena() END,
       pg_temp.broker_id()
FROM qa_categories c
WHERE c.company_id = pg_temp.nw()
ON CONFLICT (id) DO NOTHING;


-- ── activity feed ───────────────────────────────────────────────────────────
-- This file runs AFTER seed-extra.sql, because it reuses the people and the
-- Operations/Tax/Contracts folders that file creates for Northwind. That
-- ordering means seed-extra's own Northwind activity pass has already run, over
-- a company that had no requests and one document — so the upload and request
-- events for everything seeded here have to be generated below instead.
--
-- They use the SAME derived id seed-extra would compute (`9a100000` over
-- `<row id>upload` / `<row id>request`), so if that file is ever re-run after
-- this one its inserts collide on the id and do nothing, rather than adding a
-- second copy of every event.
INSERT INTO activity_log (id, company_id, type, message, created_by, created_at)
SELECT pg_temp.nw_id('9a100000', r.id::text || 'request'), pg_temp.nw(),
       'request'::activity_type, 'Requested "' || r.title || '"',
       r.created_by, r.created_at
FROM requests r WHERE r.company_id = pg_temp.nw()
ON CONFLICT (id) DO NOTHING;

INSERT INTO activity_log (id, company_id, type, message, created_by, created_at)
SELECT pg_temp.nw_id('8a100000', r.id::text || 'approved'), pg_temp.nw(),
       'approved'::activity_type, 'Marked "' || r.title || '" complete',
       pg_temp.broker_id(), r.created_at + interval '5 days'
FROM requests r WHERE r.company_id = pg_temp.nw() AND r.status = 'completed'
ON CONFLICT (id) DO NOTHING;

INSERT INTO activity_log (id, company_id, type, message, created_by, created_at)
SELECT pg_temp.nw_id('8a100000', r.id::text || 'reminder'), pg_temp.nw(),
       'reminder'::activity_type, 'Chased "' || r.title || '"',
       pg_temp.broker_id(), now() - interval '2 days'
FROM requests r WHERE r.company_id = pg_temp.nw() AND r.status IN ('pending', 'blocked')
ON CONFLICT (id) DO NOTHING;


-- ── messages ────────────────────────────────────────────────────────────────
INSERT INTO message_groups (id, company_id, name, group_type, buyer_user_id, auto_created)
VALUES
  (pg_temp.nw_id('8c100000', 'deal'), pg_temp.nw(), 'Deal team — Northwind Logistics', 'deal_team', NULL, false),
  (pg_temp.nw_id('8c100000', 'internal'), pg_temp.nw(), 'Broker internal — Project Compass', 'broker_internal', NULL, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO message_group_members (group_id, user_id)
SELECT pg_temp.nw_id('8c100000', 'deal'), u FROM (VALUES
  (pg_temp.broker_id()), (pg_temp.tom()), (pg_temp.elena()), (pg_temp.rosa())
) AS v(u)
ON CONFLICT DO NOTHING;

INSERT INTO message_group_members (group_id, user_id)
SELECT pg_temp.nw_id('8c100000', 'internal'), u FROM (VALUES
  (pg_temp.broker_id()), (pg_temp.rosa()), (pg_temp.elena()), (pg_temp.admin_id())
) AS v(u)
ON CONFLICT DO NOTHING;

INSERT INTO group_messages (id, group_id, sender_id, body, created_at)
SELECT pg_temp.nw_id('8d100000', v.tag),
       pg_temp.nw_id('8c100000', v.grp),
       CASE v.who WHEN 'broker' THEN pg_temp.broker_id()
                  WHEN 'analyst' THEN pg_temp.elena()
                  WHEN 'rosa' THEN pg_temp.rosa() ELSE pg_temp.tom() END,
       v.body, now() - (v.age || ' hours')::interval
FROM (VALUES
  ('g1','deal','broker','Kicking off Project Compass. Twenty-one requests are live on the board — the audited financials and the concentration analysis are the two that gate everything else.', 220),
  ('g2','deal','seller','Understood. Audits are with our accountant, the concentration file I can pull from the TMS this week.', 210),
  ('g3','deal','analyst','I have started the SDE bridge from the FY2025 trial balance. Two questions already in Q&A on the owner comp and the Kent rent.', 190),
  ('g4','deal','seller','Both fair. The Kent lease is with a family entity — we have a broker opinion of value from March that should settle the rent question.', 176),
  ('g5','deal','analyst','That is exactly what I need, thank you. Please drop it under Operations and I will cite it in the bridge.', 168),
  ('g6','deal','broker','Uploaded the top-20 concentration file. Cascade at 21% is going to be the first thing every buyer asks about.', 120),
  ('g7','deal','seller','Retention on Cascade is 100% since 2019 and we are on the renewal that runs to 2027. Happy to say so on the record.', 112),
  ('g8','deal','rosa','Adding myself — I am covering while Blake is at the conference next week. Ping me on anything time-critical.', 96),
  ('g9','deal','broker','Loss runs are up. 2024 is an outlier year, one at-fault accident, and the scorecard programme post-dates it.', 60),
  ('g10','deal','seller','The fleet appraisal came back — submitting it to the board now for approval.', 30),
  ('i1','internal','broker','Internal: hold Carrier Agreements and HR back until LOI. Round 1 sees Financials, Commercial, Legal and Operations only.', 200),
  ('i2','internal','analyst','Internal: the owner-operator classification is the real tail risk on this one, not the concentration. Counsel memo is privileged and not in the room.', 150),
  ('i3','internal','rosa','Internal: three bidders in Round 1. Kestrel is the most likely to move to LOI on price, Tidewater on speed.', 88),
  ('i4','internal','broker','Internal: do not circulate the SDE bridge v1 — the owner comp benchmark moved and v2 is the one to send.', 54)
) AS v(tag, grp, who, body, age)
ON CONFLICT (id) DO NOTHING;

INSERT INTO company_messages (id, company_id, sender_id, body, created_at)
SELECT pg_temp.nw_id('8e100000', v.tag), pg_temp.nw(),
       CASE v.who WHEN 'broker' THEN pg_temp.broker_id() ELSE pg_temp.tom() END,
       v.body, now() - (v.age || ' hours')::interval
FROM (VALUES
  ('c1','broker','Welcome to the Northwind data room. Everything we need from you is on the requests board, in priority order.', 260),
  ('c2','seller','Thanks — Marta and I will work through it this week.', 250),
  ('c3','broker','One process note: please do not delete or replace documents. Upload the new version onto the existing document so the history stays intact.', 240),
  ('c4','seller','Understood. The June close package is up as v2 — the first one had the fuel accrual in the wrong period.', 100),
  ('c5','broker','Perfect, that is exactly the right way to do it.', 96)
) AS v(tag, who, body, age)
ON CONFLICT (id) DO NOTHING;

INSERT INTO direct_messages (id, company_id, sender_id, recipient_id, body, created_at)
SELECT pg_temp.nw_id('8f300000', v.tag), pg_temp.nw(),
       CASE v.dir WHEN 'out' THEN pg_temp.broker_id() ELSE pg_temp.tom() END,
       CASE v.dir WHEN 'out' THEN pg_temp.tom() ELSE pg_temp.broker_id() END,
       v.body, now() - (v.age || ' hours')::interval
FROM (VALUES
  ('d1','out','Quick one — is the fleet appraisal something you already have, or should I commission it?', 140),
  ('d2','in','We have one from January for the bank. I will submit it, though it predates the two tractors we sold.', 132),
  ('d3','out','That works, just note the two disposals when you submit so nobody reconciles to the wrong unit count.', 128),
  ('d4','in','Done. Also — how hard is the change-of-control consent from Cascade likely to be?', 40),
  ('d5','out','Not hard, but not fast either. Four weeks is realistic once we can name the buyer. Worth starting the conversation early.', 36)
) AS v(tag, dir, body, age)
ON CONFLICT (id) DO NOTHING;


-- ── file references ─────────────────────────────────────────────────────────
INSERT INTO file_references (id, company_id, document_id, linked_module, linked_entity_id, metadata, created_by)
SELECT pg_temp.nw_id('8a200000', d.id::text), pg_temp.nw(), d.id, 'key_reports', NULL,
       jsonb_build_object('report', 'Trial Balance', 'period', 'FY2025'),
       pg_temp.broker_id()
FROM documents d
WHERE d.company_id = pg_temp.nw() AND d.name = 'Trial Balance FY2025.txt'
ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS nw_doc_spec;
DROP TABLE IF EXISTS nw_doc;
DROP TABLE IF EXISTS nw_req;
DROP TABLE IF EXISTS nw_qa;

COMMIT;
