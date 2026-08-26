import { describe, expect, it } from "vitest";
import pg from "pg";
import { createDb } from "./client.js";

/**
 * The connection this package hands everything else.
 *
 * Only one thing here is worth asserting, and it is the audit's H2 finding: TLS
 * must be governed by the connection string's `sslmode`, never by a hardcoded
 * `rejectUnauthorized: false`. That override makes every connection accept any
 * certificate, which is indistinguishable from a working connection right up
 * until somebody is between you and the database.
 *
 * A pool does not dial until it is queried, so this costs no database.
 */

const URL = "postgres://someone:secret@db.example.test:5432/datahub?sslmode=verify-full";

describe("createDb", () => {
  it("leaves TLS to the connection string rather than forcing it off", () => {
    const created: pg.PoolConfig[] = [];
    const RealPool = pg.Pool;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg as any).Pool = class extends RealPool {
      constructor(config: pg.PoolConfig) {
        created.push(config);
        super(config);
      }
    };

    try {
      createDb(URL);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg as any).Pool = RealPool;
    }

    expect(created).toHaveLength(1);
    const config = created[0]!;
    expect(config.connectionString).toBe(URL);
    // Not `false`, and not an object switching verification off. Absent, so
    // `sslmode` in the URL decides.
    expect(config.ssl).toBeUndefined();
  });

  it("bounds the pool rather than letting it grow without limit", () => {
    // Unbounded, a burst of requests opens a connection each and the database
    // refuses them all at once — including the ones already in flight.
    const created: pg.PoolConfig[] = [];
    const RealPool = pg.Pool;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg as any).Pool = class extends RealPool {
      constructor(config: pg.PoolConfig) {
        created.push(config);
        super(config);
      }
    };

    try {
      createDb(URL);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg as any).Pool = RealPool;
    }

    expect(created[0]!.max).toBeGreaterThan(0);
  });

  it("answers a client bound to the schema", () => {
    const db = createDb(URL);
    expect(db).toBeDefined();
    expect(typeof db.select).toBe("function");
  });
});
