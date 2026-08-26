-- Northwind Logistics: the buy side, and the traffic it generates.
--
-- The first two Northwind seeds build the deal; this one builds the people
-- looking at it. A data room with no bidders in it reads as a filing cabinet —
-- the buyer groups, the folder grants, the view history and the message threads
-- are what make it look like a live process.
--
-- It also lights up the notification bell, which is derived rather than stored:
-- `MessageNotificationsContext` builds notifications client-side from direct and
-- group messages the signed-in user has not marked seen, so the only way to make
-- the bell show a count is genuine recent inbound traffic addressed to Blake
-- Broker. There is no notifications table to seed.
--
-- Same reserved `8x` id space, same derived-id scheme, idempotent throughout.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.nw_id(prefix text, key text)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT (prefix || '-0000-4000-8000-' || substr(md5(key), 1, 12))::uuid;
$$;

CREATE OR REPLACE FUNCTION pg_temp.nw() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'a0000000-0000-4000-8000-000000000002'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.broker_id() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'b0000000-0000-4000-8000-000000000002'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.elena() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-000000000003'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.rosa() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-000000000001'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.tom() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-000000000008'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.priya() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-000000000005'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.ingrid() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-00000000000a'::uuid $$;


-- ── the bidders ─────────────────────────────────────────────────────────────
-- Same bcrypt digest of `demo1234` every other seeded account uses, so these can
-- sign in once the Better Auth backfill runs. Run it after this file:
--   DATABASE_URL=... pnpm --filter @datahub/demo backfill
--
-- The role enum is (admin, broker, buyer) only, so seller-side staff are `buyer`
-- with sub_role 'seller' — the convention seed.sql and seed-extra.sql both use.
INSERT INTO users (id, name, email, password_hash, role, company_id, status,
                   sub_role, designation, buyer_company_name, broker_company, phone)
VALUES
  ('81000000-0000-4000-8000-000000000001', 'Lena Vasquez', 'buyer.vasquez@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   'a0000000-0000-4000-8000-000000000002', 'active',
   'buyer', 'Managing Director', 'Continental Freight Partners', NULL, '+1 206 555 0188'),
  ('81000000-0000-4000-8000-000000000002', 'Josh Feldman', 'buyer.feldman@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   'a0000000-0000-4000-8000-000000000002', 'active',
   'buyer', 'Principal', 'Halyard Capital Group', NULL, '+1 415 555 0143'),
  ('81000000-0000-4000-8000-000000000003', 'Amara Diallo', 'buyer.diallo@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   'a0000000-0000-4000-8000-000000000002', 'active',
   'buyer', 'Director, M&A', 'Pinnacle Logistics Holdings', NULL, '+1 312 555 0176'),
  ('81000000-0000-4000-8000-000000000004', 'Wes Hartley', 'buyer.hartley@demo.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   'a0000000-0000-4000-8000-000000000002', 'active',
   'buyer', 'Vice President', 'Cascadia Industrial Partners', NULL, '+1 503 555 0121'),
  -- Seller-side finance, so the deal has someone other than the founder answering.
  ('81000000-0000-4000-8000-000000000005', 'Marta Devlin', 'cfo.devlin@northwind.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   'a0000000-0000-4000-8000-000000000002', 'active',
   'seller', 'Chief Financial Officer', NULL, NULL, '+1 206 555 0134'),
  ('81000000-0000-4000-8000-000000000006', 'Ray Okafor', 'ops.okafor@northwind.test',
   '$2a$10$p6HbWbPjhCQJM.7HDy6ZquDUJ24rG3oPAkG1IFXxqbCkK7pmBd5Um', 'buyer',
   'a0000000-0000-4000-8000-000000000002', 'active',
   'seller', 'VP Operations', NULL, NULL, '+1 206 555 0159')
ON CONFLICT (id) DO UPDATE SET
  password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, role = EXCLUDED.role,
  status = EXCLUDED.status, sub_role = EXCLUDED.sub_role,
  designation = EXCLUDED.designation, buyer_company_name = EXCLUDED.buyer_company_name,
  phone = EXCLUDED.phone;

INSERT INTO user_companies (user_id, company_id)
SELECT u.id, pg_temp.nw() FROM users u WHERE u.id::text LIKE '81%'
ON CONFLICT DO NOTHING;


-- ── rounds ──────────────────────────────────────────────────────────────────
-- Round 1 holds every bidder; Round 2 is the two that survived. Modelling the
-- narrowing is what makes the group switch on the folder-grant screen worth
-- clicking — everyone in both groups shows nothing.
INSERT INTO buyer_group_members (group_id, user_id)
SELECT pg_temp.nw_id('89000000', 'r1'), u FROM (VALUES
  ('81000000-0000-4000-8000-000000000001'::uuid),
  ('81000000-0000-4000-8000-000000000002'::uuid),
  ('81000000-0000-4000-8000-000000000003'::uuid),
  ('81000000-0000-4000-8000-000000000004'::uuid)
) AS v(u)
ON CONFLICT DO NOTHING;

INSERT INTO buyer_group_members (group_id, user_id)
SELECT pg_temp.nw_id('89000000', 'r2'), u FROM (VALUES
  ('81000000-0000-4000-8000-000000000001'::uuid),
  ('81000000-0000-4000-8000-000000000003'::uuid)
) AS v(u)
ON CONFLICT DO NOTHING;

-- Round 1 sees the commercial and financial folders; the Round 2 shortlist also
-- gets HR, carriers and insurance. Wes Hartley is deliberately Round 1 only, so
-- there is a bidder whose access visibly stops somewhere.
INSERT INTO folder_access (id, folder_id, user_id, can_read, can_write, can_download, created_by)
SELECT pg_temp.nw_id('88000000', f.id::text || u.uid::text), f.id, u.uid,
       true, false, true, pg_temp.broker_id()
FROM folders f
CROSS JOIN (VALUES
  ('81000000-0000-4000-8000-000000000001'::uuid),
  ('81000000-0000-4000-8000-000000000002'::uuid),
  ('81000000-0000-4000-8000-000000000003'::uuid),
  ('81000000-0000-4000-8000-000000000004'::uuid)
) AS u(uid)
WHERE f.company_id = pg_temp.nw()
  AND f.name IN ('Financials', 'Commercial', 'Legal', 'Operations', 'Tax',
                 'Monthly Close', 'Bank Statements', 'Customer Contracts')
ON CONFLICT (id) DO NOTHING;

INSERT INTO folder_access (id, folder_id, user_id, can_read, can_write, can_download, created_by)
SELECT pg_temp.nw_id('88000000', f.id::text || u.uid::text), f.id, u.uid,
       true, false, true, pg_temp.broker_id()
FROM folders f
CROSS JOIN (VALUES
  ('81000000-0000-4000-8000-000000000001'::uuid),
  ('81000000-0000-4000-8000-000000000003'::uuid)
) AS u(uid)
WHERE f.company_id = pg_temp.nw()
  AND f.name IN ('HR', 'Drivers', 'Carrier Agreements', 'Insurance & Risk',
                 'Debt & Equipment', 'Permits & Licences')
ON CONFLICT (id) DO NOTHING;


-- ── who has been reading what ───────────────────────────────────────────────
-- Weighted rather than uniform: the two Round 2 bidders have been through the
-- financials, and the Round 1 pair have not. A view history where everyone has
-- read everything tells a visitor nothing.
INSERT INTO document_activity (id, document_id, user_id, activity_type, created_at, actor_id, action, at)
SELECT pg_temp.nw_id('87000000', d.id::text || u.uid::text || v.kind),
       d.id, u.uid, v.kind::document_activity_type,
       now() - ((v.age + u.lag) || ' hours')::interval,
       u.uid, v.kind, now() - ((v.age + u.lag) || ' hours')::interval
FROM documents d
CROSS JOIN (VALUES ('view', 18), ('download', 14)) AS v(kind, age)
CROSS JOIN (VALUES
  ('81000000-0000-4000-8000-000000000001'::uuid, 0),
  ('81000000-0000-4000-8000-000000000003'::uuid, 7)
) AS u(uid, lag)
WHERE d.company_id = pg_temp.nw()
ON CONFLICT (id) DO NOTHING;

-- The Round 1 pair have only opened the headline files.
INSERT INTO document_activity (id, document_id, user_id, activity_type, created_at, actor_id, action, at)
SELECT pg_temp.nw_id('87000000', d.id::text || u.uid::text || 'view'),
       d.id, u.uid, 'view'::document_activity_type,
       now() - ((26 + u.lag) || ' hours')::interval,
       u.uid, 'view', now() - ((26 + u.lag) || ' hours')::interval
FROM documents d
CROSS JOIN (VALUES
  ('81000000-0000-4000-8000-000000000002'::uuid, 0),
  ('81000000-0000-4000-8000-000000000004'::uuid, 9)
) AS u(uid, lag)
WHERE d.company_id = pg_temp.nw()
  AND d.name IN ('Trial Balance FY2025.txt', 'SDE Bridge FY2023-FY2025.txt',
                 'Top 20 Customers FY2025.txt', 'Fleet Schedule 2026.txt',
                 'Project Compass CIM v1.pdf', 'Lane Profitability FY2025.txt')
ON CONFLICT (id) DO NOTHING;


-- ── per-buyer message groups ────────────────────────────────────────────────
-- One thread per bidder, which is how the product models buyer comms: a
-- `buyer_group_type` group carrying the buyer's user id.
INSERT INTO message_groups (id, company_id, name, group_type, buyer_user_id, auto_created)
SELECT pg_temp.nw_id('8c100000', 'buyer' || u.id::text), pg_temp.nw(),
       u.buyer_company_name, 'buyer', u.id, true
FROM users u WHERE u.id::text LIKE '81%' AND u.sub_role = 'buyer'
ON CONFLICT (id) DO NOTHING;

INSERT INTO message_group_members (group_id, user_id)
SELECT pg_temp.nw_id('8c100000', 'buyer' || u.id::text), m.uid
FROM users u
CROSS JOIN LATERAL (VALUES (u.id), (pg_temp.broker_id()), (pg_temp.rosa())) AS m(uid)
WHERE u.id::text LIKE '81%' AND u.sub_role = 'buyer'
ON CONFLICT DO NOTHING;

INSERT INTO group_messages (id, group_id, sender_id, body, created_at)
SELECT pg_temp.nw_id('8d100000', v.tag),
       pg_temp.nw_id('8c100000', 'buyer' || v.buyer),
       CASE v.who WHEN 'broker' THEN pg_temp.broker_id()
                  WHEN 'rosa' THEN pg_temp.rosa()
                  ELSE v.buyer::uuid END,
       v.body, now() - (v.age || ' hours')::interval
FROM (VALUES
  ('b1','81000000-0000-4000-8000-000000000001','broker','Access is live for Round 1 — Financials, Commercial, Legal and Operations. Shout if anything looks like it is missing.', 190),
  ('b2','81000000-0000-4000-8000-000000000001','buyer','Thanks. We have been through the close packages. The operating ratio trend is the story here — nice to see it improving on rate rather than on cost cutting.', 170),
  ('b3','81000000-0000-4000-8000-000000000001','broker','Agreed, and the empty-mile reduction is the durable part of it. Lane profitability file has the detail.', 160),
  ('b4','81000000-0000-4000-8000-000000000001','buyer','We are minded to go to LOI. Can we get HR and the carrier agreements opened up this week?', 30),
  ('b5','81000000-0000-4000-8000-000000000001','broker','Done — Round 2 access is on your account now.', 26),
  ('b6','81000000-0000-4000-8000-000000000002','broker','Welcome in. Round 1 access is live.', 186),
  ('b7','81000000-0000-4000-8000-000000000002','buyer','Appreciated. We are going to need to understand the owner-operator classification before we can get comfortable.', 96),
  ('b8','81000000-0000-4000-8000-000000000002','broker','Understood — it is QA-208 on the board. Counsel memo is privileged, available under a common-interest agreement post-LOI.', 88),
  ('b9','81000000-0000-4000-8000-000000000003','broker','Round 1 access live. The CIM is in Financials as a PDF.', 184),
  ('b10','81000000-0000-4000-8000-000000000003','buyer','Read it. The concentration on Cascade is the thing we will want to spend time on — is management open to a call?', 74),
  ('b11','81000000-0000-4000-8000-000000000003','rosa','Yes. I can offer Thursday or Friday morning next week, an hour with the founder and the CFO.', 68),
  ('b12','81000000-0000-4000-8000-000000000003','buyer','Thursday works. We will send questions ahead so it is not a cold start.', 22),
  ('b13','81000000-0000-4000-8000-000000000004','broker','Round 1 access is live — let me know how you get on.', 180),
  ('b14','81000000-0000-4000-8000-000000000004','buyer','Thanks. Being straight with you: fleet age is heavier than we normally take on. We will look, but it may not be for us.', 50)
) AS v(tag, buyer, who, body, age)
ON CONFLICT (id) DO NOTHING;

-- Read state: the broker is caught up on the two quiet threads and behind on the
-- two active ones, which is what leaves an unread count rather than a clean slate.
INSERT INTO group_message_reads (group_id, user_id, last_read_at)
SELECT pg_temp.nw_id('8c100000', 'buyer' || v.buyer), pg_temp.broker_id(),
       now() - (v.age || ' hours')::interval
FROM (VALUES
  ('81000000-0000-4000-8000-000000000002', 40),
  ('81000000-0000-4000-8000-000000000004', 40)
) AS v(buyer, age)
ON CONFLICT (group_id, user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at;


-- ── direct messages ─────────────────────────────────────────────────────────
-- The notification bell reads unread DMs and group messages, so these are the
-- rows that make it show a number. Recent and inbound to Blake on purpose.
INSERT INTO direct_messages (id, company_id, sender_id, recipient_id, body, created_at)
SELECT pg_temp.nw_id('8f300000', v.tag), pg_temp.nw(),
       v.sender::uuid, v.recipient::uuid, v.body,
       now() - (v.age || ' hours')::interval
FROM (VALUES
  ('n1','81000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002',
   'Blake — our IC meets Tuesday. If we can get the estoppel on the Kent lease before then it materially helps the case.', 5),
  ('n2','81000000-0000-4000-8000-000000000003','b0000000-0000-4000-8000-000000000002',
   'Sending our question list for Thursday tonight. Mostly concentration and the owner transition.', 8),
  ('n3','81000000-0000-4000-8000-000000000005','b0000000-0000-4000-8000-000000000002',
   'Refreshed appraisal is ordered — the appraiser says Friday. I will load it as v2 on the existing document.', 11),
  ('n4','81000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000002',
   'Can you confirm whether the equipment notes accelerate on change of control? It is the open item on our side.', 19),
  ('n5','81000000-0000-4000-8000-000000000006','b0000000-0000-4000-8000-000000000002',
   'Driver pay scales and the retro history are both loaded now. Anything else from Operations?', 27),
  ('n6','b0000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000005',
   'Perfect. Once the appraisal lands I will move the fleet request to complete.', 10),
  ('n7','b0000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000001',
   'Estoppel is with the landlord — it is the seller''s own entity so I expect it back quickly.', 4)
) AS v(tag, sender, recipient, body, age)
ON CONFLICT (id) DO NOTHING;


-- ── more company-wide traffic ───────────────────────────────────────────────
INSERT INTO company_messages (id, company_id, sender_id, body, created_at)
SELECT pg_temp.nw_id('8e100000', v.tag), pg_temp.nw(), v.sender::uuid, v.body,
       now() - (v.age || ' hours')::interval
FROM (VALUES
  ('c6','b0000000-0000-4000-8000-000000000002','Round 1 is now four bidders. Two have signalled they will move to LOI, so expect a step up in question volume this week.', 84),
  ('c7','81000000-0000-4000-8000-000000000005','FY2025 close package is final and tied to the trial balance. Please treat that version as the reference for anything financial.', 78),
  ('c8','b0000000-0000-4000-8000-000000000002','Reminder to the deal team: answers go through Q&A, not email. It is the audit trail we hand over at close.', 62),
  ('c9','81000000-0000-4000-8000-000000000006','Safety pack is complete — compliance review, accident register, drug and alcohol programme and the DQ audit are all loaded.', 46),
  ('c10','91000000-0000-4000-8000-000000000003','I have started the earnings bridge from the FY2025 ledger. Two add-backs still need a supporting schedule: the related-party rent and the owner vehicle costs.', 36)
) AS v(tag, sender, body, age)
ON CONFLICT (id) DO NOTHING;


-- ── comments from the buy side ──────────────────────────────────────────────
-- Shared visibility, because a buyer cannot see internal threads — which is the
-- distinction the comment panel exists to demonstrate.
-- Documents are resolved by NAME rather than by derived id: the CIM PDF is
-- created by seed-cim-northwind.mjs with a generated uuid, so it has no derived
-- id to look up, and a join is correct for every other row anyway.
INSERT INTO document_comments (id, document_id, company_id, author_id, body, visibility, created_at)
SELECT pg_temp.nw_id('86000000', v.file || v.tag), d.id,
       pg_temp.nw(), v.who::uuid, v.body, v.visibility,
       now() - (v.age || ' hours')::interval
FROM (VALUES
  ('SDE Bridge FY2023-FY2025.txt','y1','shared','81000000-0000-4000-8000-000000000001',
   'Can the owner compensation add-back be supported with the actual W-2 and the benchmark it is measured against? It is the largest single line in the bridge.', 92),
  ('SDE Bridge FY2023-FY2025.txt','y2','shared','b0000000-0000-4000-8000-000000000002',
   'Yes — v2 reflects a revised benchmark of 185k and the supporting detail is in QA-203.', 80),
  ('Top 20 Customers FY2025.txt','y3','shared','81000000-0000-4000-8000-000000000003',
   'What is the contract position on the top three? Concentration matters much less if they are all under multi-year agreements.', 70),
  ('Top 20 Customers FY2025.txt','y4','shared','b0000000-0000-4000-8000-000000000002',
   'All three are contracted: Cascade to Jan 2027, Pacific Foods to Jun 2027, Harborview to Aug 2027. The agreements are in Legal.', 64),
  ('Equipment Schedule 2026.txt','y5','shared','81000000-0000-4000-8000-000000000004',
   'Average tractor age of 4.2 years with eleven units past 600k miles — is the replacement capex in the forecast enough to hold that flat?', 48),
  ('Debt Schedule 2026.txt','y6','shared','81000000-0000-4000-8000-000000000002',
   'Please confirm the change-of-control position on the equipment notes. Raised as QA-218 as well.', 20),
  ('Lane Profitability FY2025.txt','y7','shared','81000000-0000-4000-8000-000000000001',
   'The Boise-Spokane lane looks like it should just be exited. Has that been modelled?', 16),
  ('Project Compass CIM v1.pdf','y8','shared','81000000-0000-4000-8000-000000000003',
   'Good document. The transaction section is thin — structure and owner transition are both blank.', 12),
  ('Close Package Jun 2026.txt','y9','internal','91000000-0000-4000-8000-000000000003',
   'June ties. I am using this and the December close as the two anchors for the bridge.', 8)
) AS v(file, tag, visibility, who, body, age)
JOIN documents d ON d.company_id = pg_temp.nw() AND d.name = v.file
ON CONFLICT (id) DO NOTHING;


-- ── evidence attached to answers ────────────────────────────────────────────
-- The join a visitor is most likely to test: an answer that cites a document,
-- and the document opening from the Q&A thread.
INSERT INTO qa_attachments (id, item_id, response_id, document_id, folder_id, created_by)
SELECT pg_temp.nw_id('8f500000', v.ref || v.doc),
       pg_temp.nw_id('8e000000', v.ref),
       pg_temp.nw_id('8f000000', v.ref),
       d.id, d.folder_id, pg_temp.broker_id()
FROM (VALUES
  ('QA-203', 'SDE Bridge FY2023-FY2025.txt'),
  ('QA-204', 'Kent Terminal Lease.txt'),
  ('QA-207', 'Master Services — Cascade Grocers.txt'),
  ('QA-209', 'Litigation Summary 2026.txt'),
  ('QA-212', 'Employee Census.txt'),
  ('QA-217', 'Equipment Schedule 2026.txt'),
  ('QA-219', 'Debt Schedule 2026.txt'),
  ('QA-222', 'Kent Terminal Lease.txt'),
  ('QA-223', 'FMCSA Operating Authority.txt'),
  ('QA-225', 'Drug and Alcohol Program.txt'),
  ('QA-226', 'DOT Compliance Review 2025.txt'),
  ('QA-228', 'Workers Comp Experience Mod.txt')
) AS v(ref, doc)
JOIN documents d ON d.company_id = pg_temp.nw() AND d.name = v.doc
WHERE EXISTS (SELECT 1 FROM qa_responses r WHERE r.id = pg_temp.nw_id('8f000000', v.ref))
ON CONFLICT (id) DO NOTHING;


-- ── the CIM prep workspace ──────────────────────────────────────────────────
INSERT INTO workspace_page_state (id, company_id, page_key, payload)
VALUES (
  pg_temp.nw_id('8a300000', 'cim-prep'), pg_temp.nw(), 'cim-prep',
  jsonb_build_object(
    'lastSection', 'transaction',
    'openGaps', jsonb_build_array('28:structure', '19:owner_dependence',
                                  '13:concentration_commentary', '22:organic_growth'),
    'notes', 'Transaction section is the blocker — owner will not commit to a structure until the IC feedback is in.'
  )
)
ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now();

COMMIT;
