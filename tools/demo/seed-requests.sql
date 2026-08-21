-- Broker→seller document and narrative requests for Acme Manufacturing.
--
-- The requests surface was the one screen a booth visitor could reach and find
-- completely empty: the module is fully built and wired, and nothing had ever
-- been seeded into it. An empty board reads as "unfinished" far more loudly than
-- a missing tab does.
--
-- Due dates are relative to `current_date`, never literals. A fixed date drifts
-- into the past and leaves every item permanently overdue, so the board would
-- look worse each week without anyone touching the code.
--
-- The set is chosen to show the states the board actually renders — every
-- status, every response type, both submission sources, and one item still
-- waiting on broker approval — rather than six rows that differ only by title.

INSERT INTO requests (
  id, company_id, title, sub_label, description, category, response_type,
  priority, status, due_date, assigned_to, created_by,
  reminder_frequency_days, submission_source, approval_status, approved_by, approved_at
) VALUES
  -- Overdue on purpose, and the only one that is: a board with nothing pressing
  -- has nothing to demonstrate, and a board that is all red looks broken.
  ('d1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'FY2024 audited financial statements', 'Signed by the auditor',
   'The full audited set including the auditor''s opinion letter, notes, and any management letter issued alongside it.',
   'Finance', 'Upload', 'critical', 'pending', current_date - 2,
   'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002',
   2, 'broker', 'approved', 'b0000000-0000-4000-8000-000000000002', now() - interval '9 days'),

  ('d1000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'Executed premises lease', 'Including any amendments',
   'The signed lease for the operating premises, with every amendment and side letter. Note the landlord is an affiliate of the seller.',
   'Legal', 'Both', 'high', 'in-review', current_date + 3,
   'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002',
   2, 'broker', 'approved', 'b0000000-0000-4000-8000-000000000002', now() - interval '6 days'),

  ('d1000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   '2024 federal tax return', 'As filed',
   'The complete filed return with all schedules, so the tax-return data source can be reconciled against the company financials.',
   'Tax', 'Upload', 'medium', 'completed', current_date + 10,
   'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002',
   3, 'broker', 'approved', 'b0000000-0000-4000-8000-000000000002', now() - interval '14 days'),

  ('d1000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001',
   'Key employee retention arrangements', NULL,
   'Describe any retention, bonus or change-of-control arrangements for the management team, and whether a sale triggers them.',
   'HR', 'Narrative', 'medium', 'pending', current_date + 7,
   'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002',
   3, 'broker', 'approved', 'b0000000-0000-4000-8000-000000000002', now() - interval '4 days'),

  -- Blocked shows the seller pushing back rather than going quiet, which is the
  -- state a diligence board exists to make visible.
  ('d1000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001',
   'Certificates of insurance', 'General liability and workers'' compensation',
   'Current certificates for every active policy. Blocked: the broker of record is mid-renewal and cannot issue certificates until it completes.',
   'Compliance', 'Upload', 'low', 'blocked', current_date + 14,
   'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002',
   5, 'broker', 'approved', 'b0000000-0000-4000-8000-000000000002', now() - interval '11 days'),

  -- Raised by the seller and NOT yet approved, so the approval gate has
  -- something to act on. `visible` stays true; approval is what gates it.
  ('d1000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001',
   'Customer concentration detail', 'Requested by the seller''s advisor',
   'Top-20 customer revenue by year, so the concentration narrative in the CIM can be supported with figures rather than assertion.',
   'M&A', 'Both', 'high', 'pending', current_date + 5,
   'b0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000003',
   2, 'client', 'pending', NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- A narrative on the item whose response type accepts one, so the narrative
-- pane opens onto something written rather than an empty editor.
INSERT INTO request_narratives (id, request_id, content, updated_by, updated_at) VALUES
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002',
   'The premises are leased from Cascade Holdings LLC, an entity controlled by the seller. Current rent is above the market rate for comparable space; the quality-of-earnings bridge carries the excess as a related-party add-back.',
   'b0000000-0000-4000-8000-000000000003', now() - interval '2 days')
ON CONFLICT (id) DO NOTHING;

-- Documents already in the data room, attached to the requests that asked for
-- them. This is the join a visitor is most likely to test by clicking.
INSERT INTO request_documents (id, request_id, document_id, visible, created_at) VALUES
  ('d3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002',
   'f0000000-0000-4000-8000-000000000002', true, now() - interval '2 days'),
  ('d3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000003',
   'f0000000-0000-4000-8000-000000000003', true, now() - interval '8 days')
ON CONFLICT (id) DO NOTHING;

-- One chase on the overdue item, so the reminder history is not empty where the
-- board is most likely to be inspected.
INSERT INTO request_reminders (id, request_id, sent_by, sent_at) VALUES
  ('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-000000000002', now() - interval '1 day')
ON CONFLICT (id) DO NOTHING;
