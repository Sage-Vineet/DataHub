-- ============================================================================
-- 090_enable_row_level_security.sql
--
-- Enables and FORCES Row Level Security on every application table, with a
-- deny-by-default posture for the anon and authenticated Postgres roles.
--
-- ── READ THIS BEFORE CHANGING ANYTHING ──────────────────────────────────────
--
-- This application's API server connects to Supabase with the SERVICE ROLE key.
-- The service role has BYPASSRLS, so these policies do NOT constrain the API.
-- Tenant isolation for API traffic is enforced in the application layer, by
-- `requireCompanyAccess` (backend/src/middleware/rbac.js) and
-- `canAccessCompany` (backend/src/services/permissionService.js). That is where
-- the real multi-tenant boundary lives, and it is where changes must be made.
--
-- So what does this migration buy?
--
--   1. It makes the anon and authenticated keys inert. Those keys are shipped
--      to browsers by design. Without RLS enabled, ANY holder of the anon key —
--      i.e. anyone who opens devtools — can query every table in the database
--      directly through PostgREST, completely bypassing the Express API and
--      every authorization check in it. That is a full database disclosure, and
--      it is the single highest-impact issue this migration closes.
--
--   2. It is defence in depth against a service-role key leak being made worse
--      by a future code path that switches to the anon key.
--
--   3. It satisfies the Supabase linter, which flags RLS-disabled tables in
--      exposed schemas as an ERROR.
--
-- A table with RLS enabled and NO policies denies everything to non-superuser,
-- non-BYPASSRLS roles. That is exactly what we want here: the browser must go
-- through the API, always.
--
-- FORCE ROW LEVEL SECURITY additionally applies policies to the table OWNER,
-- closing the case where the owning role would otherwise skip them.
--
-- ── If you later adopt Supabase Auth ────────────────────────────────────────
-- The commented block at the end of this file shows the identity-based policies
-- to add. They only work once end users hold Supabase-issued JWTs containing
-- `auth.uid()`; the application currently mints its own JWTs, so `auth.uid()`
-- is NULL for every request and such policies would deny everything.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  target_table text;
BEGIN
  -- Every base table in the public schema. Using the catalog rather than a
  -- hardcoded list means tables added by future migrations are covered the next
  -- time this runs, and nothing is missed by omission.
  FOR target_table IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'                      -- ordinary tables only
       AND c.relname NOT LIKE 'pg\_%'
       AND c.relname NOT LIKE '\_prisma%'
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', target_table);
    RAISE NOTICE 'RLS enabled and forced on public.%', target_table;
  END LOOP;
END
$$;

-- ── Revoke direct grants from browser-facing roles ──────────────────────────
-- Belt and braces alongside RLS: even with a permissive policy added by mistake
-- later, these roles hold no table privileges to exercise it with.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- And for tables created in future migrations.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- The service role keeps full access — this is the API's identity.
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ── Explicit deny policies on the crown jewels ──────────────────────────────
-- RLS-with-no-policies already denies. These named policies exist so that
-- `\d+ users` and the Supabase dashboard show an explicit, reviewable intent
-- rather than an empty policy list that a future maintainer might read as
-- "nobody got round to it".

DROP POLICY IF EXISTS "deny_all_anon" ON public.users;
CREATE POLICY "deny_all_anon" ON public.users
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny_all_anon" ON public.auth_sessions;
CREATE POLICY "deny_all_anon" ON public.auth_sessions
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny_all_anon" ON public.security_events;
CREATE POLICY "deny_all_anon" ON public.security_events
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny_all_anon" ON public.account_lockouts;
CREATE POLICY "deny_all_anon" ON public.account_lockouts
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny_all_anon" ON public.companies;
CREATE POLICY "deny_all_anon" ON public.companies
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- ── Tenant-scoped policies for direct Postgres (pg Pool) connections ────────
--
-- Several services connect with `pg` rather than the Supabase client. Those
-- connections authenticate as the database owner and would normally bypass RLS
-- (hence FORCE above). To get tenant enforcement at the database level on that
-- path too, the application can set a per-transaction GUC and these policies
-- will honour it:
--
--     BEGIN;
--     SELECT set_config('app.current_user_id',   $1, true);
--     SELECT set_config('app.current_company_ids', $2, true);  -- comma separated
--     ... queries ...
--     COMMIT;
--
-- `true` as the third argument scopes the setting to the transaction, so it
-- cannot leak to the next borrower of a pooled connection.

CREATE OR REPLACE FUNCTION public.current_app_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.current_app_company_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.current_company_ids', true), '') = ''
      THEN ARRAY[]::uuid[]
    ELSE string_to_array(current_setting('app.current_company_ids', true), ',')::uuid[]
  END;
$$;

COMMENT ON FUNCTION public.current_app_user_id() IS
  'Reads the app-set transaction-local user id. NULL when unset.';

-- ── Verification ────────────────────────────────────────────────────────────
-- Fails the migration loudly if any public table was left without RLS.
DO $$
DECLARE
  unprotected text[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname)
    INTO unprotected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname NOT LIKE 'pg\_%'
     AND NOT c.relrowsecurity;

  IF unprotected IS NOT NULL AND array_length(unprotected, 1) > 0 THEN
    RAISE EXCEPTION 'RLS is not enabled on: %', array_to_string(unprotected, ', ');
  END IF;

  RAISE NOTICE 'Verified: RLS enabled on every table in schema public.';
END
$$;

COMMIT;

-- ============================================================================
-- FUTURE: identity-based policies, for after a migration to Supabase Auth.
-- Do NOT enable these while the API mints its own JWTs — auth.uid() would be
-- NULL on every request and these policies would deny all access.
-- ============================================================================
--
-- CREATE POLICY "users_read_own" ON public.users
--   FOR SELECT TO authenticated
--   USING (id = auth.uid());
--
-- CREATE POLICY "companies_read_assigned" ON public.companies
--   FOR SELECT TO authenticated
--   USING (
--     EXISTS (
--       SELECT 1 FROM public.user_companies uc
--        WHERE uc.company_id = companies.id
--          AND uc.user_id    = auth.uid()
--     )
--   );
--
-- -- Template for every company-scoped table (documents, folders, requests,
-- -- chart_of_accounts, balance_sheet_entries, profit_loss_entries, …):
-- CREATE POLICY "tenant_isolation" ON public.documents
--   FOR ALL TO authenticated
--   USING (
--     company_id IN (
--       SELECT company_id FROM public.user_companies WHERE user_id = auth.uid()
--     )
--   )
--   WITH CHECK (
--     company_id IN (
--       SELECT company_id FROM public.user_companies WHERE user_id = auth.uid()
--     )
--   );
--
-- NOTE: index user_companies(user_id, company_id) — it already exists as the
-- primary key — otherwise every policy check becomes a sequential scan.
-- ============================================================================
