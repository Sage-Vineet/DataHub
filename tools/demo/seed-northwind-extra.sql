-- Northwind Logistics, second pass: depth behind the headline folders.
--
-- seed-northwind.sql makes every screen non-empty. This file makes the data room
-- feel like one somebody has actually been working in for six months — a run of
-- monthly closes rather than one, named counterparties rather than a single
-- example contract, and the permits and schedules a freight buyer asks for by
-- name.
--
-- Same reserved `8x` id space and the same derived-id scheme, so it composes
-- with seed-northwind.sql and re-runs without duplicating.

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
CREATE OR REPLACE FUNCTION pg_temp.tom() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-000000000008'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.priya() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-000000000005'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.ingrid() RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT '91000000-0000-4000-8000-00000000000a'::uuid $$;


-- ── four more subfolders ────────────────────────────────────────────────────
INSERT INTO folders (id, company_id, name, parent_id, created_by, created_at)
SELECT pg_temp.nw_id('82000000', v.parent || '/' || v.name), pg_temp.nw(), v.name,
       (SELECT p.id FROM folders p
         WHERE p.company_id = pg_temp.nw() AND p.name = v.parent AND p.parent_id IS NULL),
       pg_temp.broker_id(), now() - (v.age || ' days')::interval
FROM (VALUES
  ('Legal',      'Permits & Licences',   34),
  ('Operations', 'Drivers',              33),
  ('Financials', 'Debt & Equipment',     31),
  ('Commercial', 'RFPs & Bids',          30)
) AS v(parent, name, age)
ON CONFLICT DO NOTHING;


-- ── documents ───────────────────────────────────────────────────────────────
CREATE TEMP TABLE nw2_spec AS
SELECT * FROM (VALUES
  -- A run of monthly closes, so the trend is inspectable rather than asserted.
  ('Monthly Close', 'Close Package Apr 2026.txt', E'Northwind Logistics — month-end close package\nPeriod: April 2026\nRevenue 3,761,940 | Gross margin 30.1% | Operating ratio 0.95\nEmpty miles 12.9% | Loads 4,118', 82, 'verified', 1, 'seller'),
  ('Monthly Close', 'Close Package Mar 2026.txt', E'Northwind Logistics — month-end close package\nPeriod: March 2026\nRevenue 3,904,215 | Gross margin 30.6% | Operating ratio 0.94\nEmpty miles 12.4% | Loads 4,286', 112, 'verified', 1, 'seller'),
  ('Monthly Close', 'Close Package Feb 2026.txt', E'Northwind Logistics — month-end close package\nPeriod: February 2026\nRevenue 3,402,880 | Gross margin 29.4% | Operating ratio 0.96\nShort month; two weather closures at the Spokane terminal.', 140, 'verified', 1, 'seller'),
  ('Monthly Close', 'Close Package Jan 2026.txt', E'Northwind Logistics — month-end close package\nPeriod: January 2026\nRevenue 3,588,410 | Gross margin 29.9% | Operating ratio 0.95\nAnnual rate increases effective 01-01 on eight of the top ten accounts.', 170, 'verified', 1, 'seller'),
  ('Monthly Close', 'Close Package Dec 2025.txt', E'Northwind Logistics — month-end close package\nPeriod: December 2025 (FY2025 close)\nRevenue 4,041,332 | Gross margin 31.1% | Operating ratio 0.92\nFY2025 total revenue 18,443,209.', 200, 'verified', 2, 'seller'),
  ('Bank Statements', 'Operating Account May 2026.txt', E'Cascade Commercial Bank — operating account 4471\nMay 2026. Opening 744,881.02 | Closing 812,440.19\n198 deposits, 361 disbursements.', 53, 'verified', 1, 'seller'),
  ('Bank Statements', 'Operating Account Apr 2026.txt', E'Cascade Commercial Bank — operating account 4471\nApril 2026. Opening 690,114.77 | Closing 744,881.02', 83, 'verified', 1, 'seller'),
  ('Bank Statements', 'Payroll Account Jun 2026.txt', E'Cascade Commercial Bank — payroll account 4488\nJune 2026. 26 disbursements, 2,214,880.16 total.\nSemi-monthly cycle, 118 payees.', 23, 'verified', 1, 'seller'),
  -- Financial schedules a buyer asks for by name.
  ('Debt & Equipment', 'Debt Schedule 2026.txt', E'Outstanding debt as at 2026-06-30\nEquipment notes (11 tractors) 1,284,400 @ 6.9%, matures 2029-2031\nRevolving line 2,000,000 facility, 340,000 drawn @ SOFR+2.75\nNo subordinated or related-party debt.', 44, 'verified', 2, 'broker'),
  ('Debt & Equipment', 'Equipment Schedule 2026.txt', E'Rolling stock as at 2026-06-30\n41 power units: 30 owned, 11 financed. Average age 4.2 yrs.\n96 trailers: 71 dry van, 19 reefer, 6 flatbed. Average age 6.8 yrs.\nNet book value 4,118,600 | Appraised orderly liquidation 4,760,000', 42, 'under-review', 1, 'broker'),
  ('Debt & Equipment', 'Fleet Appraisal Jan 2026.txt', E'Independent appraisal — Cascade Equipment Valuation\nDate of value 2026-01-14. Orderly liquidation 4,760,000, forced 3,570,000.\nNOTE: predates disposal of two 2018 tractors in March 2026.', 40, 'under-review', 1, 'seller'),
  ('Financials', 'AR Ageing Jun 2026.txt', E'Aged receivables as at 2026-06-30\nCurrent 1,884,220 | 31-60 412,880 | 61-90 96,410 | 90+ 41,220\nDSO 38.4 days. Allowance 62,000 against 90+ balances.', 21, 'verified', 1, 'seller'),
  ('Financials', 'AP Ageing Jun 2026.txt', E'Aged payables as at 2026-06-30\nCurrent 981,440 | 31-60 214,880 | 61-90 18,200 | 90+ 0\nDPO 31.2 days. No supplier on credit hold.', 21, 'verified', 1, 'seller'),
  ('Financials', '13-Week Cash Flow.txt', E'Rolling 13-week cash forecast, prepared weekly\nOpening 968,114 | Minimum projected balance 611,400 (week 7)\nRevolver undrawn capacity 1,660,000 throughout.', 19, 'under-review', 1, 'seller'),
  ('Financials', 'Bad Debt History.txt', E'Write-offs by fiscal year\nFY2021 41,200 | FY2022 18,900 | FY2023 62,400 | FY2024 22,100 | FY2025 9,800\nFY2023 is a single customer bankruptcy (Pinehurst Wholesale).', 17, 'verified', 1, 'broker'),
  -- Named counterparties: contracts, not "a contract".
  ('Customer Contracts', 'Master Services — Harborview Building Supply.txt', E'Master services agreement — Harborview Building Supply\nEffective 2021-09-01, renewed 2024-09-01 through 2027-08-31.\nCHANGE OF CONTROL: consent required (schedule 4).', 34, 'under-review', 1, 'broker'),
  ('Customer Contracts', 'Dedicated Fleet — Cascade Grocers.txt', E'Dedicated fleet addendum — Cascade Grocers Co-op\n14 dedicated units, guaranteed weekly capacity, indexed fuel.\nTermination on 180 days notice. Runs to 2027-01-31.', 33, 'verified', 1, 'broker'),
  ('Customer Contracts', 'Supply Agreement — Yakima Produce Co-op.txt', E'Seasonal supply agreement — Yakima Produce Co-op\nJune to October reefer capacity, rate reset annually.\nNo change-of-control provision.', 32, 'verified', 1, 'broker'),
  ('Carrier Agreements', 'Broker-Carrier Agreement — Sunrise Transport.txt', E'Broker-carrier agreement — Sunrise Transport LLC\nOverflow capacity, standard NMFTA terms, 1M auto liability required.', 31, 'verified', 1, 'broker'),
  ('Carrier Agreements', 'Broker-Carrier Agreement — Ridgeway Freight.txt', E'Broker-carrier agreement — Ridgeway Freight Inc\nOverflow capacity. Certificate on file, expires 2026-10-14.', 30, 'verified', 1, 'broker'),
  -- Permits and compliance: the freight-specific diligence set.
  ('Permits & Licences', 'FMCSA Operating Authority.txt', E'Motor carrier operating authority MC-684221\nGranted 2009-06-02, active. Interstate property, non-hazmat.\nBOC-3 process agent on file in all 48 states.', 29, 'verified', 1, 'broker'),
  ('Permits & Licences', 'IFTA and UCR Registrations.txt', E'IFTA licence WA-4471882, current through 2026-12-31\nUCR registration current, 41 units declared.\nWA UTC permit current; OR weight-mile account in good standing.', 28, 'verified', 1, 'broker'),
  ('Permits & Licences', 'Kent Terminal Occupancy Permit.txt', E'City of Kent certificate of occupancy, cross-dock use.\nIssued 2014-03-18, no outstanding conditions. Fire inspection current to 2027-01.', 27, 'verified', 1, 'broker'),
  ('Safety & Compliance', 'Drug and Alcohol Program.txt', E'DOT drug and alcohol testing programme\nConsortium: Pacific Compliance Services. Random rate 50% drivers, 10% alcohol.\nNo positive tests in trailing 24 months. Clearinghouse queries current.', 26, 'verified', 1, 'seller'),
  ('Safety & Compliance', 'Accident Register 2021-2026.txt', E'DOT-recordable accident register, five years\n2021: 2 | 2022: 3 | 2023: 1 | 2024: 4 (one at-fault injury) | 2025: 1 | 2026 YTD: 0\nPreventable rate 0.61 per million miles against industry 0.9.', 25, 'under-review', 1, 'seller'),
  ('Safety & Compliance', 'DOT Compliance Review 2025.txt', E'FMCSA compliance review, 2025-03-11\nRating: SATISFACTORY. Two non-critical violations noted, both remediated within 30 days:\nrecord-of-duty-status form errors and one expired medical certificate.', 24, 'verified', 1, 'broker'),
  ('Drivers', 'Driver Pay Scales 2026.txt', E'Company driver pay, effective 2026-01-01\nRegional 0.62/mile plus 24/stop | Dedicated 1,340/week guaranteed\nSafety bonus 0.03/mile at scorecard 90+. Owner-operator 72% of linehaul.', 23, 'verified', 1, 'seller'),
  ('Drivers', 'Workers Comp Experience Mod.txt', E'Washington L&I experience rating\n2024 0.94 | 2025 0.88 | 2026 0.81\nRetro group member, Northwest Transportation Retro Program.', 22, 'verified', 1, 'seller'),
  ('Drivers', 'Union Status Letter.txt', E'Counsel letter — labour status\nNo collective bargaining agreement in place. No petition filed or pending.\nOne 2019 organising attempt at the Kent dock withdrawn before election.', 21, 'verified', 1, 'broker'),
  -- Commercial depth.
  ('Commercial', 'Lane Profitability FY2025.txt', E'Contribution by lane, FY2025 (top 8 of 34)\nSeattle-Spokane 1,884,200 rev / 34.1% CM\nSeattle-Portland 1,610,880 rev / 31.8% CM\nYakima-Seattle 1,204,410 rev / 36.2% CM (seasonal reefer)\nBoise-Spokane 688,200 rev / 22.4% CM — under review for exit', 20, 'under-review', 2, 'broker'),
  ('RFPs & Bids', 'RFP Response — Northgate Foods 2026.txt', E'Bid response — Northgate Foods regional distribution\nSubmitted 2026-04-30. 12 lanes, est. 2.1m annual. Outcome pending.', 18, 'under-review', 1, 'broker'),
  ('RFPs & Bids', 'Bid Log 2024-2026.txt', E'Competitive bid log\n2024: 14 bids, 5 won (36%) | 2025: 11 bids, 5 won (45%) | 2026 YTD: 6 bids, 2 won, 1 pending\nWin rate improves where dedicated capacity is offered.', 17, 'verified', 1, 'broker'),
  ('IT & Systems', 'Disaster Recovery Plan.txt', E'DR and business continuity\nTMS hosted on-premise at Kent with nightly offsite backup to Spokane.\nRTO 8 hours, RPO 24 hours. Last restore test 2025-09-22, successful.\nNOTE: single on-premise instance is a concentration risk.', 16, 'under-review', 1, 'broker'),
  ('IT & Systems', 'Cyber Insurance Certificate.txt', E'Cyber liability — 1,000,000 limit, 25,000 retention\nCarrier: Sound Risk Partners placement. Renews 2026-11-01.\nNo claims in policy history.', 15, 'verified', 1, 'seller'),
  ('Environmental', 'Phase I ESA — Spokane.txt', E'Phase I environmental site assessment — Spokane terminal\nCompleted 2025-08-26. No recognised environmental conditions.\nAdjacent parcel has a historic dry-cleaner listing; vapour pathway assessed and screened out.', 14, 'verified', 1, 'broker'),
  ('Insurance & Risk', 'Insurance Schedule 2026.txt', E'Programme summary, policy year to 2026-11-01\nAuto liability 1M | Cargo 250k | GL 2M agg | Umbrella 5M | Workers comp WA L&I\nTotal annual premium 684,200. Deductibles: auto 25k, cargo 25k.', 13, 'verified', 1, 'seller')
) AS v(folder_name, file_name, body, age_days, status, versions, owner);

CREATE TEMP TABLE nw2 AS
SELECT s.*,
  (SELECT f.id FROM folders f
    WHERE f.company_id = pg_temp.nw() AND f.name = s.folder_name) AS folder_id,
  CASE s.owner WHEN 'broker' THEN pg_temp.broker_id() ELSE pg_temp.tom() END AS actor
FROM nw2_spec s;

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(folder_name || '/' || file_name, ', ') INTO missing
  FROM nw2 WHERE folder_id IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'unresolved folders: %', missing;
  END IF;
END $$;

INSERT INTO uploads (id, file_name, content_type, size_bytes, data, prefix, uploaded_by, created_at)
SELECT pg_temp.nw_id('84000000', d.file_name || g.n::text),
       d.file_name, 'text/plain',
       length(convert_to(d.body || E'\n\n[revision ' || g.n || ']', 'UTF8')),
       convert_to(d.body || E'\n\n[revision ' || g.n || ']', 'UTF8'),
       'documents', d.actor,
       now() - ((d.age_days - (g.n - 1) * 5) || ' days')::interval
FROM nw2 d CROSS JOIN LATERAL generate_series(1, d.versions) AS g(n)
ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, size_bytes = EXCLUDED.size_bytes;

INSERT INTO documents (id, company_id, folder_id, name, file_url, upload_id, size, ext,
                       status, uploaded_by, uploaded_at, version_count)
SELECT pg_temp.nw_id('83000000', d.file_name), pg_temp.nw(), d.folder_id, d.file_name, '',
       pg_temp.nw_id('84000000', d.file_name || d.versions::text),
       length(convert_to(d.body || E'\n\n[revision ' || d.versions || ']', 'UTF8'))::text,
       'txt', d.status::document_status, d.actor,
       now() - (d.age_days || ' days')::interval, d.versions
FROM nw2 d
ON CONFLICT (id) DO UPDATE SET
  upload_id = EXCLUDED.upload_id, version_count = EXCLUDED.version_count,
  status = EXCLUDED.status, folder_id = EXCLUDED.folder_id;

INSERT INTO document_versions (id, document_id, version_no, upload_id, file_name,
                               size_bytes, content_type, note, created_by, created_at)
SELECT pg_temp.nw_id('85000000', d.file_name || g.n::text),
       pg_temp.nw_id('83000000', d.file_name), g.n,
       pg_temp.nw_id('84000000', d.file_name || g.n::text), d.file_name,
       length(convert_to(d.body || E'\n\n[revision ' || g.n || ']', 'UTF8')),
       'text/plain',
       CASE g.n WHEN 1 THEN NULL ELSE 'Reissued after review' END,
       d.actor,
       now() - ((d.age_days - (g.n - 1) * 5) || ' days')::interval
FROM nw2 d CROSS JOIN LATERAL generate_series(1, d.versions) AS g(n)
ON CONFLICT (id) DO NOTHING;

UPDATE documents doc SET current_version_id =
  pg_temp.nw_id('85000000', d.file_name || d.versions::text)
FROM nw2 d
WHERE doc.id = pg_temp.nw_id('83000000', d.file_name);

-- Upload activity for the new documents, using the SAME derived id seed-extra.sql
-- would compute for them (`9a100000` over `<doc id>upload`). Same key, same uuid,
-- so when seed-extra runs afterwards its insert is a no-op rather than a second
-- copy of every event.
INSERT INTO activity_log (id, company_id, type, message, created_by, created_at)
SELECT pg_temp.nw_id('9a100000', d.id::text || 'upload'), d.company_id,
       'upload'::activity_type, 'Uploaded ' || d.name, d.uploaded_by, d.uploaded_at
FROM documents d WHERE d.company_id = pg_temp.nw()
ON CONFLICT (id) DO NOTHING;


-- ── more comments, on the documents that invite them ────────────────────────
INSERT INTO document_comments (id, document_id, company_id, author_id, body, visibility, created_at)
SELECT pg_temp.nw_id('86000000', v.file || v.tag),
       pg_temp.nw_id('83000000', v.file), pg_temp.nw(),
       CASE v.who WHEN 'broker' THEN pg_temp.broker_id()
                  WHEN 'analyst' THEN pg_temp.elena() ELSE pg_temp.tom() END,
       v.body, v.visibility, now() - (v.age || ' hours')::interval
FROM (VALUES
  ('Fleet Appraisal Jan 2026.txt', 'x1', 'internal', 'analyst',
   'This appraisal predates the March disposal of two 2018 tractors. Either get it refreshed or footnote the unit count — a buyer reconciling to the equipment schedule will find the gap.', 88),
  ('Fleet Appraisal Jan 2026.txt', 'x2', 'shared', 'seller',
   'Noted. The appraiser has quoted 2,400 for a desktop update; we will commission it this week.', 74),
  ('Debt Schedule 2026.txt', 'x3', 'internal', 'broker',
   'Confirm whether the equipment notes carry a change-of-control acceleration. If they do, that is a payoff at close and it changes the net proceeds materially.', 66),
  ('Lane Profitability FY2025.txt', 'x4', 'internal', 'analyst',
   'Boise-Spokane at 22.4% contribution is dragging the blended margin. Worth presenting the exit case proactively — it reads as upside rather than a problem.', 58),
  ('Lane Profitability FY2025.txt', 'x5', 'shared', 'broker',
   'v2 splits out the seasonal reefer lanes, which were masking the underlying dry van margin.', 44),
  ('Disaster Recovery Plan.txt', 'x6', 'internal', 'analyst',
   'Single on-premise TMS instance with a 24-hour RPO is the one IT finding worth flagging. Cheap to fix, but a buyer will price it if we do not raise it first.', 40),
  ('Accident Register 2021-2026.txt', 'x7', 'shared', 'seller',
   'The 2024 at-fault injury is the Ramirez matter. Reserve is set and it is the only claim above the deductible in five years.', 34),
  ('AR Ageing Jun 2026.txt', 'x8', 'internal', 'broker',
   'DSO of 38.4 is good for this sector. Worth calling out against the 45-day industry median in the CIM financial summary.', 28),
  ('Bad Debt History.txt', 'x9', 'shared', 'broker',
   'FY2023 is one customer bankruptcy, not a credit-policy problem. The narrative should say so plainly.', 22),
  ('Close Package Dec 2025.txt', 'x10', 'internal', 'analyst',
   'FY2025 close ties to the trial balance. This is the version the SDE bridge is built from — do not supersede it without telling me.', 16)
) AS v(file, tag, visibility, who, body, age)
ON CONFLICT (id) DO NOTHING;


-- ── a second wave of Q&A ────────────────────────────────────────────────────
CREATE TEMP TABLE nw2_qa AS
SELECT * FROM (VALUES
  ('finance', 'QA-217', 'Maintenance cost per mile', 'Maintenance is 0.19 per mile against a regional benchmark near 0.16. Is that fleet age or deferred work?', 'answered', 'high', 'QE', 'Cost of Revenue', 20, 15),
  ('finance', 'QA-218', 'Equipment note acceleration', 'Do the equipment notes accelerate on a change of control, and what is the payoff at close?', 'open', 'critical', 'QE', 'Debt', 9, NULL),
  ('finance', 'QA-219', 'Revolver covenants', 'What financial covenants attach to the revolving line, and what is current headroom?', 'answered', 'medium', 'QE', 'Debt', 16, 11),
  ('finance', 'QA-220', 'Capex versus depreciation', 'Capex has run below depreciation for two years. Is there a deferred replacement need?', 'open', 'high', 'QE', 'Capital', 8, NULL),
  ('finance', 'QA-221', 'Fuel hedging', 'Is any portion of fuel hedged, or is the surcharge the only protection?', 'answered', 'low', 'QE', 'Cost of Revenue', 14, 10),
  ('legal', 'QA-222', 'Terminal lease assignment', 'Is the Kent lease assignable on a sale, and does the related-party landlord change the analysis?', 'answered', 'critical', 'Legal', 'Contracts', 15, 8),
  ('legal', 'QA-223', 'Operating authority transfer', 'Does the MC authority transfer with a stock sale, and what is required for an asset sale?', 'answered', 'high', 'Legal', 'Permits', 13, 7),
  ('legal', 'QA-224', 'Broker-carrier indemnities', 'What indemnity do the overflow carriers carry, and is Northwind exposed on their cargo claims?', 'open', 'medium', 'Legal', 'Contracts', 7, NULL),
  ('compliance', 'QA-225', 'Clearinghouse compliance', 'Are all Clearinghouse queries current, and has any driver had a positive result?', 'answered', 'high', 'Compliance', 'Permits', 12, 6),
  ('compliance', 'QA-226', 'Hours-of-service violations', 'The 2025 review noted RODS form errors. What changed operationally after that?', 'answered', 'medium', 'Compliance', 'Permits', 11, 5),
  ('hr', 'QA-227', 'Owner-operator pay parity', 'Owner-operators take 72% of linehaul. How does that compare to the market, and is it sustainable?', 'open', 'medium', 'HR', 'People', 6, NULL),
  ('hr', 'QA-228', 'Workers comp retro exposure', 'The business is in a retro group. What is the maximum retro assessment exposure?', 'answered', 'medium', 'HR', 'People', 10, 4),
  ('ma', 'QA-229', 'Working capital peg', 'What working capital peg does the seller expect, and on what averaging period?', 'open', 'critical', 'M&A', 'Structure', 5, NULL),
  ('ma', 'QA-230', 'Real estate treatment', 'Both terminals are leased. Is the related-party Kent lease intended to continue post-close?', 'open', 'high', 'M&A', 'Structure', 4, NULL)
) AS v(cat_key, reference, title, body, status, priority, module_tag, section_tag, asked_days, answered_days);

INSERT INTO qa_items (id, company_id, category_id, reference, title, body, status,
                      priority, origin, module_tag, section_tag, requestor_id,
                      created_by, asked_at, answered_at, due_date)
SELECT pg_temp.nw_id('8e000000', q.reference), pg_temp.nw(),
       (SELECT id FROM qa_categories c WHERE c.company_id = pg_temp.nw() AND c.key = q.cat_key),
       'NWL-' || q.reference, q.title, q.body, q.status, q.priority, 'manual',
       q.module_tag, q.section_tag,
       CASE q.module_tag WHEN 'QE' THEN pg_temp.elena() ELSE pg_temp.broker_id() END,
       pg_temp.broker_id(),
       now() - (q.asked_days || ' days')::interval,
       CASE WHEN q.answered_days IS NULL THEN NULL
            ELSE now() - (q.answered_days || ' days')::interval END,
       (now() + interval '12 days')::date
FROM nw2_qa q
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, answered_at = EXCLUDED.answered_at;

INSERT INTO qa_responses (id, item_id, citation_ref, kind, body, author_id, posted_at,
                          answer_root_id, answer_version, is_current)
SELECT pg_temp.nw_id('8f000000', q.reference), pg_temp.nw_id('8e000000', q.reference),
       'NWL-' || q.reference || '-A1', 'answer',
       CASE q.reference
         WHEN 'QA-217' THEN 'Fleet age, not deferred work. Eleven units are past 600,000 miles and carry the majority of the cost; preventive maintenance compliance is 94.1% and roadside out-of-service is 3 of 62 inspections. The replacement schedule in the capex forecast brings the blended figure back toward 0.16 by FY2028.'
         WHEN 'QA-219' THEN 'Two covenants: fixed charge coverage of at least 1.25x and funded debt to EBITDA no greater than 3.0x, both tested quarterly. Current coverage is 2.14x and leverage 0.94x, so headroom is substantial and there has been no waiver or breach in the life of the facility.'
         WHEN 'QA-221' THEN 'No financial hedging. The weekly-indexed surcharge is the only protection and has recovered 97.2% of incremental cost over three years, which management judges sufficient given the short lag.'
         WHEN 'QA-222' THEN 'The lease is assignable with landlord consent not to be unreasonably withheld. Because the landlord is an entity controlled by the seller, consent is within the seller''s gift and will be delivered at close; an estoppel certificate confirming rent, term and no default is being prepared.'
         WHEN 'QA-223' THEN 'On a stock sale the MC authority continues unaffected, with an FMCSA notification only. On an asset sale the buyer needs its own authority, or a transfer application, which takes four to six weeks; the BOC-3 filings would be redone in either case.'
         WHEN 'QA-225' THEN 'All annual and pre-employment Clearinghouse queries are current with no gaps. There has been no positive test and no refusal in the trailing twenty-four months across both random and post-accident testing.'
         WHEN 'QA-226' THEN 'The RODS errors were form-and-manner rather than substantive hours violations. Samsara ELD settings were reconfigured in April 2025 to force annotation on every edit, and a monthly log audit was introduced. No further findings since.'
         WHEN 'QA-228' THEN 'Maximum retro assessment is capped at 130% of standard premium under the Northwest Transportation Retro Program. On the 2026 standard premium that is an exposure ceiling of roughly 214,000, against which the group has returned a refund in each of the last four plan years.'
         ELSE 'Answered by management; supporting detail is filed in the data room.'
       END,
       pg_temp.tom(), now() - (q.answered_days || ' days')::interval,
       pg_temp.nw_id('8f000000', q.reference), 1, true
FROM nw2_qa q
WHERE q.answered_days IS NOT NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO qa_assignees (id, item_id, user_id, kind, assigned_by)
SELECT pg_temp.nw_id('8f100000', q.reference), pg_temp.nw_id('8e000000', q.reference),
       pg_temp.tom(), 'requestee', pg_temp.broker_id()
FROM nw2_qa q
ON CONFLICT (id) DO NOTHING;

-- Buyer-side follow-up questions, so the thread is a conversation rather than a
-- single exchange. `kind` is 'comment' rather than 'answer' so these do not
-- compete with the answer of record.
INSERT INTO qa_responses (id, item_id, citation_ref, kind, body, author_id, posted_at,
                          answer_version, is_current)
SELECT pg_temp.nw_id('8f400000', v.ref), pg_temp.nw_id('8e000000', v.ref),
       'NWL-' || v.ref || '-C1', 'comment', v.body,
       CASE v.who WHEN 'priya' THEN pg_temp.priya() ELSE pg_temp.ingrid() END,
       now() - (v.age || ' days')::interval, 1, false
FROM (VALUES
  ('QA-217', 'priya', 'Can we see the maintenance cost split between the eleven high-mileage units and the rest of the fleet? The blended number is hard to underwrite.', 13),
  ('QA-219', 'ingrid', 'Please confirm whether the covenants are tested on a trailing twelve month basis or quarterly annualised.', 9),
  ('QA-222', 'priya', 'We would want the estoppel before signing, and a market-rate reset on the Kent lease as a condition.', 6),
  ('QA-226', 'ingrid', 'Helpful. Is the monthly log audit documented anywhere we can see?', 4),
  ('QA-228', 'priya', 'Understood — please add the last four years of retro refunds to the data room.', 3)
) AS v(ref, who, body, age)
ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS nw2_spec;
DROP TABLE IF EXISTS nw2;
DROP TABLE IF EXISTS nw2_qa;

COMMIT;
