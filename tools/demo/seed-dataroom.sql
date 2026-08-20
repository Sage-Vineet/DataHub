-- Data room demo content: documents with real bytes, version history, and a
-- comment thread that shows the internal/shared split.
--
-- Real bytes rather than empty rows, because the story being told is that the
-- preview works and the versions are genuinely different files — a document with
-- no content looks identical to a broken one.
--
-- Idempotent: fixed ids and ON CONFLICT throughout, so `reset.sh` can re-run it
-- without a rebuild.

BEGIN;

-- ── uploads: the stored bytes ───────────────────────────────────────────────
-- Small, but real and distinguishable: a preview that renders "v1 of the model"
-- proves the version list resolves to different content.
INSERT INTO uploads (id, file_name, content_type, size_bytes, data, prefix, uploaded_by)
VALUES
  ('e0000000-0000-4000-8000-000000000001', 'Financial Model.txt', 'text/plain', 42,
   convert_to('Financial Model v1 — prepared 2026-06-01', 'UTF8'), 'documents',
   'b0000000-0000-4000-8000-000000000002'),
  ('e0000000-0000-4000-8000-000000000002', 'Financial Model.txt', 'text/plain', 52,
   convert_to('Financial Model v2 — revised after Q2 close', 'UTF8'), 'documents',
   'b0000000-0000-4000-8000-000000000002'),
  ('e0000000-0000-4000-8000-000000000003', 'Financial Model.txt', 'text/plain', 60,
   convert_to('Financial Model v3 — final, includes working capital', 'UTF8'), 'documents',
   'b0000000-0000-4000-8000-000000000003'),
  ('e0000000-0000-4000-8000-000000000004', 'Lease Agreement.txt', 'text/plain', 44,
   convert_to('Lease Agreement — Unit 4, expires 2029-03-31', 'UTF8'), 'documents',
   'b0000000-0000-4000-8000-000000000003'),
  ('e0000000-0000-4000-8000-000000000005', 'AR Aging.txt', 'text/plain', 38,
   convert_to('AR Aging — as at 2026-06-30', 'UTF8'), 'documents',
   'b0000000-0000-4000-8000-000000000003')
ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, size_bytes = EXCLUDED.size_bytes;

-- ── documents ───────────────────────────────────────────────────────────────
INSERT INTO documents (id, company_id, folder_id, name, file_url, upload_id, size, ext, status, uploaded_by, version_count)
VALUES
  ('f0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001', 'Financial Model.txt', '',
   'e0000000-0000-4000-8000-000000000003', '60', 'txt', 'under-review',
   'b0000000-0000-4000-8000-000000000002', 3),
  ('f0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000002', 'Lease Agreement.txt', '',
   'e0000000-0000-4000-8000-000000000004', '44', 'txt', 'under-review',
   'b0000000-0000-4000-8000-000000000003', 1),
  ('f0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000003', 'AR Aging.txt', '',
   'e0000000-0000-4000-8000-000000000005', '38', 'txt', 'under-review',
   'b0000000-0000-4000-8000-000000000003', 1)
ON CONFLICT (id) DO UPDATE SET upload_id = EXCLUDED.upload_id, version_count = EXCLUDED.version_count;

-- ── version history ─────────────────────────────────────────────────────────
-- Three versions of one document, so the first click on version history shows a
-- real story rather than a single row.
INSERT INTO document_versions (id, document_id, version_no, upload_id, file_name, size_bytes, content_type, note, created_by, created_at)
VALUES
  ('a1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 1,
   'e0000000-0000-4000-8000-000000000001', 'Financial Model.txt', 42, 'text/plain',
   NULL, 'b0000000-0000-4000-8000-000000000002', now() - interval '40 days'),
  ('a1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001', 2,
   'e0000000-0000-4000-8000-000000000002', 'Financial Model.txt', 52, 'text/plain',
   NULL, 'b0000000-0000-4000-8000-000000000002', now() - interval '12 days'),
  ('a1000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000001', 3,
   'e0000000-0000-4000-8000-000000000003', 'Financial Model.txt', 60, 'text/plain',
   NULL, 'b0000000-0000-4000-8000-000000000003', now() - interval '2 days'),
  ('a1000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000002', 1,
   'e0000000-0000-4000-8000-000000000004', 'Lease Agreement.txt', 44, 'text/plain',
   NULL, 'b0000000-0000-4000-8000-000000000003', now() - interval '30 days'),
  ('a1000000-0000-4000-8000-000000000005', 'f0000000-0000-4000-8000-000000000003', 1,
   'e0000000-0000-4000-8000-000000000005', 'AR Aging.txt', 38, 'text/plain',
   NULL, 'b0000000-0000-4000-8000-000000000003', now() - interval '5 days')
ON CONFLICT (id) DO NOTHING;

UPDATE documents SET current_version_id = 'a1000000-0000-4000-8000-000000000003'
WHERE id = 'f0000000-0000-4000-8000-000000000001';
UPDATE documents SET current_version_id = 'a1000000-0000-4000-8000-000000000004'
WHERE id = 'f0000000-0000-4000-8000-000000000002';
UPDATE documents SET current_version_id = 'a1000000-0000-4000-8000-000000000005'
WHERE id = 'f0000000-0000-4000-8000-000000000003';

-- ── comments ────────────────────────────────────────────────────────────────
-- One internal and one shared on the same document: the seller persona sees only
-- the shared one, which is the visibility story made visible in two clicks.
INSERT INTO document_comments (id, document_id, company_id, body, visibility, author_id, created_at)
VALUES
  ('a2000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001',
   'Check the working capital line against the QoE bridge before this goes to buyers.',
   'internal', 'b0000000-0000-4000-8000-000000000002', now() - interval '1 day'),
  ('a2000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001',
   'v3 supersedes the copy circulated in June — please work from this one.',
   'shared', 'b0000000-0000-4000-8000-000000000002', now() - interval '20 hours'),
  ('a2000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000001',
   'Renewal option is in clause 14 — worth flagging in diligence.',
   'internal', 'b0000000-0000-4000-8000-000000000002', now() - interval '3 days')
ON CONFLICT (id) DO NOTHING;

COMMIT;
