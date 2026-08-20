-- Demo seed: the smallest dataset that makes the app worth looking at.
--
-- Three personas across two companies, so tenant scoping is visible rather than
-- theoretical: the broker sees Northwind and Acme, the client sees only Acme,
-- and "the other company" exists to be correctly invisible.
--
-- Password for every account is `demo1234`. The hash below is a real bcrypt
-- digest of it, so it exercises the same verification path production does —
-- including Better Auth's bcrypt-parity `verify` (ADR-0007), which is the whole
-- point of seeding a hash rather than a plaintext shortcut.
--
-- Idempotent: re-running updates rather than duplicating.

BEGIN;

INSERT INTO companies (id, name, industry, status, contact_name, contact_email, profit_metric)
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Acme Manufacturing', 'Manufacturing', 'active',
   'Dana Client', 'client@demo.test', 'adjusted_ebitda'),
  ('a0000000-0000-4000-8000-000000000002', 'Northwind Logistics', 'Logistics', 'active',
   'Sam Owner', 'owner@northwind.test', 'sde'),
  -- Belongs to no demo persona: the control that proves cross-tenant denial.
  ('a0000000-0000-4000-8000-000000000003', 'Cardinal Foods', 'Food & Beverage', 'active',
   'Pat Stranger', 'pat@cardinal.test', 'adjusted_ebitda')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, industry = EXCLUDED.industry;

INSERT INTO users (id, name, email, password_hash, role, company_id, status)
VALUES
  ('b0000000-0000-4000-8000-000000000001', 'Avery Admin', 'admin@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'admin', NULL, 'active'),
  ('b0000000-0000-4000-8000-000000000002', 'Blake Broker', 'broker@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'broker',
   'a0000000-0000-4000-8000-000000000001', 'active'),
  ('b0000000-0000-4000-8000-000000000003', 'Dana Client', 'client@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   'a0000000-0000-4000-8000-000000000001', 'active')
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role;

-- The broker works both companies; the client is confined to Acme.
INSERT INTO user_companies (user_id, company_id)
VALUES
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002'),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;

-- Folders: one archived, so the includeArchived filter has something to hide.
INSERT INTO folders (id, company_id, name, parent_id, created_by)
VALUES
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Financials', NULL, 'b0000000-0000-4000-8000-000000000002'),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'Legal', NULL, 'b0000000-0000-4000-8000-000000000002'),
  ('c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   'Tax Returns', 'c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002'),
  ('c0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002',
   'Financials', NULL, 'b0000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;

UPDATE folders SET archived_at = now()
WHERE id = 'c0000000-0000-4000-8000-000000000002' AND archived_at IS NULL;

-- Q&A categories for the seeded companies.
--
-- Migration 0003 backfills these for companies that exist WHEN IT RUNS, which on
-- a fresh stack is none — the schema lands at step 3 and these rows at step 4.
-- That ordering is not a bug in the migration (a real deployment has companies
-- already), but it does mean the demo would come up with no categories.
--
-- The durable answer is that the Q&A service provisions a company's categories on
-- first use, the way folders are provisioned; this seed is the demo's copy of the
-- same vocabulary so the data is there before anyone clicks.
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
