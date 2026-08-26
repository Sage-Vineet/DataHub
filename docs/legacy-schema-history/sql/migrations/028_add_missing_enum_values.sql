-- Migration: Add missing enum values that exist in schema.sql but not in the live DB
-- Fixes:
--   1. request_priority missing 'critical'  → INSERT fails with "invalid input value for enum request_priority: critical"
--   2. request_status  missing 'blocked'    → INSERT/UPDATE fails with "invalid input value for enum request_status: blocked"
-- Date: 2026-05-25

DO $$
BEGIN
  ALTER TYPE request_priority ADD VALUE IF NOT EXISTS 'critical';
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'blocked';
EXCEPTION WHEN others THEN NULL;
END $$;
