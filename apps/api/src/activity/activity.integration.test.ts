import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityGrantsDdl,
  activityTablesDdl,
  schema,
  upcomingPartitionsDdl,
  type Db,
} from "@datahub/db";
import { DrizzleActivityRepository } from "./repository.drizzle.js";
import { blankRecord, type ActivityRecordInput } from "./types.js";
import { ActivityWriter } from "./writer.js";

let client: PGlite;
let db: Db;
let repo: DrizzleActivityRepository;

function envelope(path: string, at = new Date("2026-08-17T12:00:00Z")): ActivityRecordInput {
  const record = blankRecord("envelope", at);
  record.correlationId = "0f1e2d3c-4b5a-4968-8776-655443332211";
  record.actorId = "user-1";
  record.actorKind = "user";
  record.engine = "legacy";
  record.method = "GET";
  record.rawPath = path;
  record.path = path;
  record.status = 200;
  record.durationMs = 4;
  return record;
}

beforeEach(async () => {
  client = new PGlite();
  await client.exec(activityTablesDdl());
  await client.exec(upcomingPartitionsDdl(new Date("2026-08-01T00:00:00Z"), 2));
  db = drizzle(client, { schema }) as unknown as Db;
  repo = new DrizzleActivityRepository(db);
});

afterEach(async () => {
  await client.close();
});

describe("activity storage (real Postgres)", () => {
  it("appends records and builds one chain", async () => {
    await repo.append([envelope("/a"), envelope("/b")]);
    await repo.append([envelope("/c")]);

    const stored = await repo.list();
    expect(stored.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(stored[0]?.prevHash).toBeNull();
    expect(stored[1]?.prevHash).toBe(stored[0]?.contentHash);
    expect(stored[2]?.prevHash).toBe(stored[1]?.contentHash);
    await expect(repo.verify()).resolves.toMatchObject({ ok: true, checked: 3 });
  });

  it("advances the chain head with the last written record", async () => {
    await repo.append([envelope("/a"), envelope("/b")]);
    const head = await db.execute(sql`SELECT last_seq, last_hash FROM activity_chain_head WHERE id = 1`);
    const row = head.rows[0] as { last_seq: number | string; last_hash: string };
    const stored = await repo.list();

    expect(Number(row.last_seq)).toBe(2);
    expect(row.last_hash).toBe(stored[1]?.contentHash);
  });

  it("detects a record altered directly in the database", async () => {
    await repo.append([envelope("/a"), envelope("/b"), envelope("/c")]);
    await db.execute(sql`UPDATE activity_events SET path = '/tampered' WHERE seq = 2`);

    const result = await repo.verify();
    expect(result.ok).toBe(false);
    expect(result.broken_at_seq).toBe(2);
  });

  it("detects a record deleted directly in the database", async () => {
    await repo.append([envelope("/a"), envelope("/b"), envelope("/c")]);
    await db.execute(sql`DELETE FROM activity_events WHERE seq = 2`);

    const result = await repo.verify();
    expect(result.ok).toBe(false);
    expect(result.broken_at_seq).toBe(3);
    expect(result.reason).toMatch(/removed/);
  });

  it("verifies a range without a record before it to check against", async () => {
    /**
     * Verifying the whole log is the honest check; verifying a range is what a
     * caller does when the log is large. Starting mid-chain the first record's
     * `prev_hash` has nothing earlier in the range to check it against, so it
     * is taken on trust — and that is the documented limit of a partial
     * verification, not a bug.
     *
     * What it still catches is everything inside the range: an alteration, and
     * a gap.
     */
    await repo.append([envelope("/a"), envelope("/b"), envelope("/c"), envelope("/d")]);

    await expect(repo.verify({ fromSeq: 3 })).resolves.toMatchObject({ ok: true, checked: 2 });

    await db.execute(sql`UPDATE activity_events SET path = '/tampered' WHERE seq = 4`);
    const tampered = await repo.verify({ fromSeq: 3 });
    expect(tampered).toMatchObject({ ok: false, broken_at_seq: 4 });
    expect(tampered.reason).toMatch(/altered/);
  });

  it("does not report a record removed BEFORE the range it was asked about", async () => {
    // The limit stated above, made explicit: seq 1 is gone, and a verification
    // starting at 2 says the range is sound — which it is. Only a verification
    // from the beginning can say the log is.
    await repo.append([envelope("/a"), envelope("/b"), envelope("/c")]);
    await db.execute(sql`DELETE FROM activity_events WHERE seq = 1`);

    await expect(repo.verify({ fromSeq: 2 })).resolves.toMatchObject({ ok: true });
    await expect(repo.verify()).resolves.toMatchObject({ ok: false, broken_at_seq: 2 });
  });

  it("verifies an empty log as sound, having checked nothing", async () => {
    // Vacuously true and worth saying: a fresh deployment must not report its
    // audit log as broken.
    await expect(repo.verify()).resolves.toEqual({
      ok: true,
      checked: 0,
      broken_at_seq: null,
      reason: null,
    });
  });

  it("writes nothing, and touches no chain head, for an empty batch", async () => {
    // The capture path batches, and a request that emitted no events reaches
    // here with an empty array. Opening a transaction and taking the chain-head
    // lock for it would serialize every such request behind one row.
    await repo.append([envelope("/a")]);
    const before = await db.execute(sql`SELECT last_seq FROM activity_chain_head WHERE id = 1`);

    expect(await repo.append([])).toEqual([]);

    const after = await db.execute(sql`SELECT last_seq FROM activity_chain_head WHERE id = 1`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect((await repo.list()).length).toBe(1);
  });

  // Design D4: immutability enforced twice. The repository has no mutation path,
  // AND the role the application connects with cannot mutate the table — so a
  // defect elsewhere in the process cannot rewrite history either.
  describe("append-only grants", () => {
    beforeEach(async () => {
      await client.exec("CREATE ROLE datahub_app NOLOGIN;");
      await client.exec(activityGrantsDdl("datahub_app"));
      await repo.append([envelope("/a")]);
    });

    it("permits INSERT as the application role", async () => {
      await client.exec("SET ROLE datahub_app");
      await expect(
        client.exec(
          `INSERT INTO activity_events (seq, occurred_at, kind, actor_kind, content_hash)
           VALUES (99, '2026-08-17T12:00:00Z', 'envelope', 'anonymous', 'abc')`,
        ),
      ).resolves.toBeDefined();
      await client.exec("RESET ROLE");
    });

    it("rejects UPDATE as the application role", async () => {
      await client.exec("SET ROLE datahub_app");
      await expect(client.exec("UPDATE activity_events SET path = '/x'")).rejects.toThrow(
        /permission denied/i,
      );
      await client.exec("RESET ROLE");
    });

    it("rejects DELETE as the application role", async () => {
      await client.exec("SET ROLE datahub_app");
      await expect(client.exec("DELETE FROM activity_events")).rejects.toThrow(
        /permission denied/i,
      );
      await client.exec("RESET ROLE");
    });
  });

  describe("partitioning", () => {
    it("routes a record to the month partition", async () => {
      await repo.append([envelope("/a", new Date("2026-08-17T12:00:00Z"))]);
      const rows = await db.execute(sql`SELECT count(*)::int AS c FROM activity_events_2026_08`);
      expect((rows.rows[0] as { c: number }).c).toBe(1);
    });

    // Forgetting to roll a partition forward must not drop audit records.
    it("catches a record outside every declared month in the default partition", async () => {
      await repo.append([envelope("/future", new Date("2031-01-05T00:00:00Z"))]);

      const fallback = await db.execute(
        sql`SELECT count(*)::int AS c FROM activity_events_default`,
      );
      expect((fallback.rows[0] as { c: number }).c).toBe(1);
      // And it is still readable through the parent, and still in the chain.
      expect(await repo.list()).toHaveLength(1);
      await expect(repo.verify()).resolves.toMatchObject({ ok: true });
    });
  });

  it("keeps one well-formed chain under concurrent appends", async () => {
    // Ten writers appending at once: the chain-head lock must serialize them into
    // one chain rather than forking it into branches that each verify alone.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => repo.append([envelope(`/c${i}`), envelope(`/d${i}`)])),
    );

    const stored = await repo.list();
    expect(stored).toHaveLength(20);
    expect(stored.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    await expect(repo.verify()).resolves.toMatchObject({ ok: true, checked: 20 });
  });

  it("drains the writer into storage with the chain intact", async () => {
    const writer = new ActivityWriter(repo, { batchSize: 3, flushIntervalMs: 0 });
    for (let i = 0; i < 10; i += 1) writer.record(envelope(`/w${i}`));
    await writer.close();

    expect(await repo.list()).toHaveLength(10);
    await expect(repo.verify()).resolves.toMatchObject({ ok: true, checked: 10 });
  });
});
