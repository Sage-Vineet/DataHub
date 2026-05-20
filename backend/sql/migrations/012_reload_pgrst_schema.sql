-- ONE-TIME SETUP: Run this entire script in the Supabase SQL Editor
-- (Dashboard → SQL Editor → New query → paste → Run).
--
-- Background: The `project_name` column was added to the `companies` table
-- via migration 011. PostgREST caches the database schema at startup and
-- needs to be told to reload it so the new column becomes visible to the
-- Supabase JS client (select/insert/update).
--
-- The transaction pooler (port 6543) does not forward LISTEN/NOTIFY, so
-- this command MUST be run from the Supabase SQL Editor or a direct
-- Postgres session — not from the backend application server.

NOTIFY pgrst, 'reload schema';
