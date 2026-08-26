-- ============================================================================
-- Migration 034: Add 'client' as a first-class DB role
-- ============================================================================
-- Previously, client users were stored as role='buyer' and the backend code
-- computed effective_role='client' at runtime by checking whether the user's
-- email matches companies.contact_email. Storing 'client' directly in the DB
-- makes role checks consistent and removes the runtime dependency.
-- This migration is idempotent: safe to re-run.
-- ============================================================================

-- Step 1: Extend the ENUM (Postgres only allows adding values, not removing).
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'client';

-- Step 2: Migrate existing buyer users who are company contact persons to
--         role='client'. Match is done by email vs companies.contact_email,
--         the same logic that the backend's isSeller check uses.
UPDATE users
SET    role       = 'client',
       updated_at = now()
FROM   companies c
WHERE  users.role   = 'buyer'
  AND  users.status = 'active'
  AND  lower(trim(users.email)) = lower(trim(c.contact_email));

-- Step 3: Ensure every client user has a user_companies row (idempotent).
INSERT INTO user_companies (user_id, company_id)
SELECT u.id, u.company_id
FROM   users u
WHERE  u.role       = 'client'
  AND  u.status     = 'active'
  AND  u.company_id IS NOT NULL
ON CONFLICT (user_id, company_id) DO NOTHING;

-- Notify PostgREST to reload its schema cache.
NOTIFY pgrst, 'reload schema';
