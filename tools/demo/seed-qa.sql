-- Deal Q&A demo content.
--
-- Enough that the module reads as a deal in progress rather than an empty
-- backlog: nominations on both sides, items across four categories at three
-- statuses, one live thread with a superseded answer, and one broker rewording
-- published beside the seller's original words.
--
-- Idempotent: fixed ids and ON CONFLICT throughout.

BEGIN;

-- Categories are provisioned by seed.sql; nominate answerers for two of them so
-- the "the seller decides who answers Finance" story works on the first click.
INSERT INTO qa_nominations (id, company_id, category_id, user_id, nominated_by)
SELECT 'b1000000-0000-4000-8000-000000000001', c.company_id, c.id,
       'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000003'
FROM qa_categories c
WHERE c.company_id = 'a0000000-0000-4000-8000-000000000001' AND c.key = 'finance'
ON CONFLICT (category_id, user_id) DO NOTHING;

INSERT INTO qa_nominations (id, company_id, category_id, user_id, nominated_by)
SELECT 'b1000000-0000-4000-8000-000000000002', c.company_id, c.id,
       'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000003'
FROM qa_categories c
WHERE c.company_id = 'a0000000-0000-4000-8000-000000000001' AND c.key = 'legal'
ON CONFLICT (category_id, user_id) DO NOTHING;

-- ── items ───────────────────────────────────────────────────────────────────
INSERT INTO qa_items (id, company_id, category_id, reference, title, body, status, priority, origin, module_tag, section_tag, requestor_id, created_by, asked_at, answered_at)
SELECT * FROM (VALUES
  ('b2000000-0000-4000-8000-000000000001'::uuid, 'a0000000-0000-4000-8000-000000000001'::uuid,
   (SELECT id FROM qa_categories WHERE company_id='a0000000-0000-4000-8000-000000000001' AND key='finance'),
   'QA-001', 'Q3 revenue variance',
   'Revenue moved 18% between Q2 and Q3. What changed operationally?',
   'answered', 'high', 'manual', 'QE', 'Revenue',
   'b0000000-0000-4000-8000-000000000002'::uuid, 'b0000000-0000-4000-8000-000000000002'::uuid,
   now() - interval '9 days', now() - interval '7 days'),
  ('b2000000-0000-4000-8000-000000000002'::uuid, 'a0000000-0000-4000-8000-000000000001'::uuid,
   (SELECT id FROM qa_categories WHERE company_id='a0000000-0000-4000-8000-000000000001' AND key='finance'),
   'QA-002', 'Owner compensation',
   'What is the owner drawing, and how much of it would not continue post-close?',
   'open', 'high', 'manual', 'QE', 'Add-backs',
   'b0000000-0000-4000-8000-000000000002'::uuid, 'b0000000-0000-4000-8000-000000000002'::uuid,
   now() - interval '4 days', NULL),
  ('b2000000-0000-4000-8000-000000000003'::uuid, 'a0000000-0000-4000-8000-000000000001'::uuid,
   (SELECT id FROM qa_categories WHERE company_id='a0000000-0000-4000-8000-000000000001' AND key='legal'),
   'QA-003', 'Lease renewal terms',
   'Does the Unit 4 lease carry a renewal option, and on what terms?',
   'answered', 'medium', 'manual', 'CM', 'Operations',
   'b0000000-0000-4000-8000-000000000002'::uuid, 'b0000000-0000-4000-8000-000000000002'::uuid,
   now() - interval '6 days', now() - interval '5 days'),
  ('b2000000-0000-4000-8000-000000000004'::uuid, 'a0000000-0000-4000-8000-000000000001'::uuid,
   (SELECT id FROM qa_categories WHERE company_id='a0000000-0000-4000-8000-000000000001' AND key='hr'),
   'QA-004', 'Key person dependence',
   'Which roles would be hardest to replace, and is there a succession plan?',
   'open', 'medium', 'manual', 'CM', 'Management',
   'b0000000-0000-4000-8000-000000000002'::uuid, 'b0000000-0000-4000-8000-000000000002'::uuid,
   now() - interval '2 days', NULL),
  ('b2000000-0000-4000-8000-000000000005'::uuid, 'a0000000-0000-4000-8000-000000000001'::uuid,
   (SELECT id FROM qa_categories WHERE company_id='a0000000-0000-4000-8000-000000000001' AND key='tax'),
   'QA-005', 'State nexus',
   'In which states does the business file, and has nexus been reviewed recently?',
   'closed', 'low', 'manual', 'QE', 'Tax',
   'b0000000-0000-4000-8000-000000000002'::uuid, 'b0000000-0000-4000-8000-000000000002'::uuid,
   now() - interval '20 days', now() - interval '18 days')
) AS v
ON CONFLICT (id) DO NOTHING;

-- ── assignment ──────────────────────────────────────────────────────────────
INSERT INTO qa_assignees (id, item_id, user_id, kind, assigned_by)
VALUES
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-000000000003', 'requestee', 'b0000000-0000-4000-8000-000000000002'),
  ('b3000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002',
   'b0000000-0000-4000-8000-000000000003', 'requestee', 'b0000000-0000-4000-8000-000000000002'),
  ('b3000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000003',
   'b0000000-0000-4000-8000-000000000003', 'requestee', 'b0000000-0000-4000-8000-000000000002'),
  ('b3000000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000004',
   'b0000000-0000-4000-8000-000000000003', 'requestee', 'b0000000-0000-4000-8000-000000000002'),
  ('b3000000-0000-4000-8000-000000000005', 'b2000000-0000-4000-8000-000000000005',
   'b0000000-0000-4000-8000-000000000003', 'requestee', 'b0000000-0000-4000-8000-000000000002')
ON CONFLICT (item_id, user_id, kind) DO NOTHING;

INSERT INTO qa_assignment_events (id, item_id, action, prior_user_ids, new_user_ids, actor_id, at)
VALUES
  ('b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
   'assigned', '{}', ARRAY['b0000000-0000-4000-8000-000000000003']::uuid[],
   'b0000000-0000-4000-8000-000000000002', now() - interval '9 days')
ON CONFLICT (id) DO NOTHING;

-- ── responses ───────────────────────────────────────────────────────────────
-- QA-001 carries a superseded answer, so the version disclosure has something to
-- disclose on the first click.
INSERT INTO qa_responses (id, item_id, citation_ref, kind, body, author_id, posted_at, supersedes_id, answer_root_id, answer_version, is_current)
VALUES
  ('b5000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
   'QA-001.R1', 'answer',
   'We lost the Henderson contract in July, it was messy, and we picked up two smaller accounts that did not cover it.',
   'b0000000-0000-4000-8000-000000000003', now() - interval '7 days',
   NULL, 'b5000000-0000-4000-8000-000000000001', 1, false),
  ('b5000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001',
   'QA-001.R2', 'answer',
   'Correcting the above: the Henderson contract ended in August, not July. The two replacement accounts started in September.',
   'b0000000-0000-4000-8000-000000000003', now() - interval '6 days',
   'b5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 2, true),
  ('b5000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001',
   'QA-001.R3', 'comment',
   'Thanks — can you send the termination letter for the file?',
   'b0000000-0000-4000-8000-000000000002', now() - interval '5 days',
   NULL, NULL, 1, true),
  ('b5000000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000003',
   'QA-003.R1', 'answer',
   'Yes — five year renewal at market rate, clause 14. We have not exercised it yet.',
   'b0000000-0000-4000-8000-000000000003', now() - interval '5 days',
   NULL, 'b5000000-0000-4000-8000-000000000004', 1, true),
  ('b5000000-0000-4000-8000-000000000005', 'b2000000-0000-4000-8000-000000000005',
   'QA-005.R1', 'answer',
   'We file in three states. Nexus was reviewed by our accountant in March.',
   'b0000000-0000-4000-8000-000000000003', now() - interval '18 days',
   NULL, 'b5000000-0000-4000-8000-000000000005', 1, true)
ON CONFLICT (id) DO NOTHING;

-- ── the broker's rewording ──────────────────────────────────────────────────
-- Published, and pointing at the seller's immutable answer. The two shown side by
-- side is the point: nothing about the original changed.
INSERT INTO qa_presentations (id, item_id, source_response_id, body, version, is_current, status, author_id, created_at)
VALUES
  ('b6000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
   'b5000000-0000-4000-8000-000000000002',
   'A single customer contract concluded in August 2026 and was partially replaced by two new accounts commencing in September.',
   1, true, 'published', 'b0000000-0000-4000-8000-000000000002', now() - interval '4 days')
ON CONFLICT (id) DO NOTHING;

-- ── evidence, filed into the data room ──────────────────────────────────────
INSERT INTO qa_attachments (id, item_id, response_id, document_id, folder_id, created_by)
VALUES
  ('b7000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000003',
   'b5000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000002',
   'c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000003')
ON CONFLICT (response_id, document_id) DO NOTHING;

COMMIT;
