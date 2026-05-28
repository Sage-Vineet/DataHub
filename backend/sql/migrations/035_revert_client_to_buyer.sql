-- ============================================================================
-- Migration 035: Revert 'client' DB role back to 'buyer'
-- ============================================================================
-- We decided to keep effective_role="client" as a code-level computation only.
-- All users that were set to role='client' in migration 034 are reverted back
-- to role='buyer'. The user_role ENUM still contains 'client' (PostgreSQL does
-- not support removing ENUM values) but the application will not write it.
-- This migration is idempotent: safe to re-run.
-- ============================================================================

UPDATE users
SET    role       = 'buyer',
       updated_at = now()
WHERE  role = 'client';

NOTIFY pgrst, 'reload schema';
