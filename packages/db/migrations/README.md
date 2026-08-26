# Drizzle migrations (auth-slice baseline)

Drizzle owns migrations for the modernized code ([ADR-0002](../../../docs/adr/0002-drizzle-data-layer.md)).

- **Baseline:** the current `src/schema.ts` models only the **auth-slice** tables (users, companies, user_companies, email_verifications, folders), hand-authored from `backend/sql/schema.sql` because no `DATABASE_URL` was reachable at authoring time (phase-1-auth design D4).
- **Reconcile with the live DB** before applying anything: `pnpm --filter @datahub/db db:pull` (introspect) or `db:generate` (emit a migration from the schema). These require `DATABASE_URL`.
- **The legacy set is frozen:** `backend/sql/migrations/*` (76 files, 19 duplicate numbers) is no longer the source of truth and receives no new migrations. It will be consolidated into a Drizzle baseline when the full schema is introspected.

Generated migration SQL will land in this directory.
