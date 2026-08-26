import { defineConfig } from "drizzle-kit";

/**
 * Drizzle owns migrations for the DataHub monorepo going forward (ADR-0002).
 * `pnpm --filter @datahub/db db:pull` introspects the live DB; `db:generate`
 * emits migrations from src/schema.ts. Requires DATABASE_URL in the environment.
 * The legacy backend/sql/migrations set is frozen and not managed here.
 */
export default defineConfig({
  // Business tables only. Better Auth's identity tables (auth-schema.ts) are
  // managed as a standalone SQL migration (migrations/0000_better_auth_identity.sql)
  // — mirroring how `@better-auth/cli` owns its schema — and are kept off
  // drizzle-kit's loader, which cannot resolve cross-file `.js` schema imports.
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
