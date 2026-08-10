import { defineConfig } from "drizzle-kit";

/**
 * Drizzle owns migrations for the DataHub monorepo going forward (ADR-0002).
 * `pnpm --filter @datahub/db db:pull` introspects the live DB; `db:generate`
 * emits migrations from src/schema.ts. Requires DATABASE_URL in the environment.
 * The legacy backend/sql/migrations set is frozen and not managed here.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
