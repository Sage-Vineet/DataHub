-- Reverse of 0000_better_auth_identity.sql. Drops the Better Auth identity tables.
-- Safe because no business table references them (auth_user.id mirrors users.id
-- by value only; there is no FK from user_companies/folders into auth_user).
DROP TABLE IF EXISTS "verification";
DROP TABLE IF EXISTS "account";
DROP TABLE IF EXISTS "session";
DROP TABLE IF EXISTS "auth_user";
