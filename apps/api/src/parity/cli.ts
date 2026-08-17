import { sql } from "drizzle-orm";
import { createDb } from "@datahub/db";
import { runParity, type RequestSpec, type Transport } from "./harness.js";
import { ParityRefusal, type MarkerReader, type StagingMarker } from "./guards.js";
import { renderJson, renderText, reportPassed } from "./report.js";

/**
 * `pnpm --filter @datahub/api parity` — run the harness against a staging target.
 *
 * The exit code reflects the verdicts, but read the coverage line before acting on
 * it: a green run over four endpoints looks identical to a green run over forty,
 * and this report is what authorizes deleting a legacy handler.
 */

/** Reads the marker the seed process writes. Absent → the harness refuses to run. */
export class PgMarkerReader implements MarkerReader {
  constructor(private readonly connectionString: string) {}

  async read(): Promise<StagingMarker | null> {
    const db = createDb(this.connectionString);
    try {
      const result = await db.execute(
        sql`SELECT seeded_at, source FROM staging_marker WHERE id = 1`,
      );
      const row = result.rows[0] as { seeded_at: Date | string; source: string } | undefined;
      if (!row) return null;
      const seededAt = row.seeded_at instanceof Date ? row.seeded_at.toISOString() : row.seeded_at;
      return { seededAt, source: row.source };
    } catch {
      // A missing table is a missing marker: the target was never seeded, which
      // the harness must treat as a refusal rather than an error to investigate.
      return null;
    }
  }
}

/** HTTP transport over the two origins. Bodies are sent as JSON; nothing is cached. */
export function httpTransport(origins: { legacy: string; module: string }): Transport {
  return async (engine, spec: RequestSpec) => {
    const base = engine === "legacy" ? origins.legacy : origins.module;
    const startedAt = process.hrtime.bigint();
    const response = await fetch(`${base}${spec.path}`, {
      method: spec.method,
      headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    });
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      /* non-JSON response: compare it as text */
    }
    return { status: response.status, body, durationMs };
  };
}

/**
 * Fixtures come from a JSON file rather than being invented here: a real request
 * needs real ids from the seeded snapshot, and guessing produces 404s that would
 * be reported as parity. No entry → the route is skipped WITH ITS REASON, which is
 * the honest outcome and shows up in the coverage section.
 */
export async function loadFixtures(path: string | undefined): Promise<Record<string, RequestSpec>> {
  if (!path) return {};
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as Record<string, RequestSpec>;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required.");
    return 2;
  }
  const legacy = env.PARITY_LEGACY_ORIGIN;
  const module = env.PARITY_MODULE_ORIGIN;
  if (!legacy || !module) {
    console.error("PARITY_LEGACY_ORIGIN and PARITY_MODULE_ORIGIN are required.");
    return 2;
  }

  const fixtures = await loadFixtures(env.PARITY_FIXTURES);

  try {
    const report = await runParity({
      connectionString,
      env,
      marker: new PgMarkerReader(connectionString),
      transport: httpTransport({ legacy, module }),
      fixtures: (route) => fixtures[`${route.method} ${route.path}`] ?? null,
      domains: env.PARITY_DOMAINS?.split(",").map((d) => d.trim()).filter(Boolean),
      sessionToken: env.PARITY_SESSION_TOKEN,
    });

    // The report is this command's output, so it goes to stdout directly rather
    // than through a logger.
    process.stdout.write(`${renderText(report)}\n`);
    if (env.PARITY_JSON_OUT) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(env.PARITY_JSON_OUT, renderJson(report), "utf8");
      process.stdout.write(`\nMachine-readable report written to ${env.PARITY_JSON_OUT}\n`);
    }
    return reportPassed(report) ? 0 : 1;
  } catch (error) {
    if (error instanceof ParityRefusal) {
      console.error(`\n${error.message}\n`);
      return 3;
    }
    throw error;
  }
}
