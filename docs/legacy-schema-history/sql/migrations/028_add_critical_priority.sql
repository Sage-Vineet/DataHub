-- Migration: Add 'critical' to request_priority enum
-- Purpose: The schema defined 'critical' but the live enum was created without it,
--          causing INSERT/UPDATE failures when priority = 'critical'.
-- Date: 2026-05-25

DO $$
BEGIN
  ALTER TYPE request_priority ADD VALUE IF NOT EXISTS 'critical';
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN others THEN NULL;
END $$;
