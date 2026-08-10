import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Create a Drizzle client over a pg pool. TLS is governed by the connection
 * string's `sslmode` (do NOT hardcode `rejectUnauthorized:false` — that is the
 * audit's H2 finding); pass a verified-CA URL in production.
 */
export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 5 });
  return drizzle(pool, { schema });
}
