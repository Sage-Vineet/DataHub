-- Migration: Add status and mapping fields to qb_synced_reports
-- Purpose: Better tracking and querying of manual GL uploads
-- Date: 2026-05-04

ALTER TABLE qb_synced_reports
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS mapping jsonb;

-- Update existing manual_gl rows to extract status and mapping from data (if any)
UPDATE qb_synced_reports
SET 
  status = data->'manual_gl'->>'status',
  mapping = data->'manual_gl'->'mapping'
WHERE report_type = 'manual_gl_upload' AND source = 'manual_gl';
