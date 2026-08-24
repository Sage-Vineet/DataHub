-- ============================================================================
-- Migration 033: Repair client user records after Supabase project migration
-- ============================================================================
-- After migrating to a new Supabase project, buyer/client users may have:
--   1. company_id = NULL (FK not restored from old project)
--   2. Stale company_id pointing to a company that no longer exists
--   3. Missing user_companies join-table rows
-- All three prevent canAccessCompany() from returning true, causing 403s.
-- This migration is idempotent: safe to re-run.
-- ============================================================================

-- Step 1: Fix buyer users whose company_id is NULL but whose email
--         matches a company's contact_email. This restores the primary
--         link broken during migration.
UPDATE users
SET    company_id  = c.id,
       updated_at  = now()
FROM   companies c
WHERE  users.role        = 'buyer'
  AND  users.status      = 'active'
  AND  users.company_id  IS NULL
  AND  lower(trim(users.email)) = lower(trim(c.contact_email));

-- Step 2: Fix buyer users whose company_id references a company that was
--         deleted / never imported into the new project, but whose email
--         still matches a live company's contact_email.
UPDATE users
SET    company_id  = c.id,
       updated_at  = now()
FROM   companies c
WHERE  users.role   = 'buyer'
  AND  users.status = 'active'
  AND  users.company_id IS NOT NULL
  AND  NOT EXISTS (
         SELECT 1 FROM companies WHERE id = users.company_id
       )
  AND  lower(trim(users.email)) = lower(trim(c.contact_email));

-- Step 3: Ensure every active buyer user who has a company_id also has a
--         corresponding row in user_companies. ON CONFLICT keeps it safe.
INSERT INTO user_companies (user_id, company_id)
SELECT id, company_id
FROM   users
WHERE  role       = 'buyer'
  AND  status     = 'active'
  AND  company_id IS NOT NULL
ON CONFLICT (user_id, company_id) DO NOTHING;

-- Step 4: For each company, ensure its contact_user (buyer whose email
--         matches contact_email) has a user_companies entry — even if
--         users.company_id was pointing somewhere unexpected.
INSERT INTO user_companies (user_id, company_id)
SELECT u.id, c.id
FROM   companies c
JOIN   users u
       ON lower(trim(u.email)) = lower(trim(c.contact_email))
       AND u.role   = 'buyer'
       AND u.status = 'active'
ON CONFLICT (user_id, company_id) DO NOTHING;

-- Notify PostgREST to reload its schema cache (Supabase-specific).
-- This ensures the FK-based join in user_companies → companies works
-- without needing a manual "Reload schema cache" click in the dashboard.
NOTIFY pgrst, 'reload schema';
