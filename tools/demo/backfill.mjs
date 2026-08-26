/**
 * Run the Better Auth identity backfill against the demo database.
 *
 * Seeding writes rows into legacy `users`; Better Auth authenticates against its
 * own `auth_user` + `account` tables (ADR-0007 design deviation D2). Without this
 * step the demo logs in fine with the flag off and fails the moment it is flipped
 * on — which would look like a broken cutover rather than an unseeded one.
 *
 * The backfill itself is the same idempotent, reversible function the production
 * rollout uses (`apps/api/src/modules/auth/backfill.ts`), not a demo-only copy.
 */
import { createDb } from "@datahub/db";
import { backfillBetterAuthIdentities } from "@datahub/api/dist/modules/auth/index.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const db = createDb(url);
const result = await backfillBetterAuthIdentities(db);
console.log(`backfill: ${JSON.stringify(result)}`);
process.exit(0);
