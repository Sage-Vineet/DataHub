import pg from "pg";
import type { MarkerReader, StagingMarker } from "./guards.js";

/**
 * The staging-marker reader the guards need, over the target's own database.
 *
 * Separate from `guards.ts` so the refusals stay pure and unit-testable — they
 * take a `MarkerReader`, and this is the one real implementation. `seed.ts`
 * writes the row this reads.
 */
export function databaseMarkerReader(connectionString: string): MarkerReader {
  return {
    async read(): Promise<StagingMarker | null> {
      const client = new pg.Client({ connectionString });
      await client.connect();
      try {
        const result = await client.query<{ seeded_at: string; source: string }>(
          "SELECT seeded_at, source FROM staging_marker WHERE id = 1",
        );
        const row = result.rows[0];
        return row ? { seededAt: String(row.seeded_at), source: row.source } : null;
      } catch (err: unknown) {
        // An absent table is an absent marker, which is a refusal rather than a
        // crash — an unseeded database is exactly what the check exists to catch.
        if (err instanceof Error && "code" in err && err.code === "42P01") return null;
        throw err;
      } finally {
        await client.end();
      }
    },
  };
}
