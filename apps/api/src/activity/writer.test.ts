import { describe, expect, it } from "vitest";
import { InMemoryActivityRepository } from "./repository.memory.js";
import { blankRecord, type ActivityRecordInput } from "./types.js";
import { ActivityWriter } from "./writer.js";

function envelope(n: number): ActivityRecordInput {
  const record = blankRecord("envelope", new Date(Date.UTC(2026, 7, 17, 12, 0, n % 60)));
  record.method = "GET";
  record.path = `/r/${n}`;
  record.status = 200;
  return record;
}

/** No background timer: these tests drive `flush()` explicitly. */
function makeWriter(repo: InMemoryActivityRepository, maxBuffer = 100): ActivityWriter {
  return new ActivityWriter(repo, { maxBuffer, batchSize: 10, flushIntervalMs: 0 });
}

describe("activity writer", () => {
  it("buffers and flushes in order", async () => {
    const repo = new InMemoryActivityRepository();
    const writer = makeWriter(repo);

    for (let i = 0; i < 25; i += 1) writer.record(envelope(i));
    expect(writer.pending).toBe(25);

    await writer.flush();

    const stored = await repo.list();
    expect(stored).toHaveLength(25);
    expect(stored.map((r) => r.path)).toEqual(Array.from({ length: 25 }, (_, i) => `/r/${i}`));
    expect(stored.map((r) => r.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("never throws from record()", () => {
    const repo = new InMemoryActivityRepository();
    repo.appendHook = (): never => {
      throw new Error("storage down");
    };
    const writer = makeWriter(repo);
    expect(() => writer.record(envelope(1))).not.toThrow();
  });

  it("writes a gap marker with an accurate count when the buffer overflows", async () => {
    const repo = new InMemoryActivityRepository();
    const writer = makeWriter(repo, 5);

    for (let i = 0; i < 12; i += 1) writer.record(envelope(i));
    // 5 buffered, 7 shed.
    expect(writer.dropped).toBe(7);

    await writer.flush();

    const stored = await repo.list();
    const gap = stored.find((r) => r.kind === "gap");
    expect(gap).toBeDefined();
    expect(gap?.droppedCount).toBe(7);
    expect(gap?.reason).toMatch(/buffer full/);
    // The notice of loss precedes the records that survived it.
    expect(stored[0]?.kind).toBe("gap");
    expect(stored.filter((r) => r.kind === "envelope")).toHaveLength(5);
  });

  it("merges consecutive losses into one marker instead of one per record", async () => {
    const repo = new InMemoryActivityRepository();
    const writer = makeWriter(repo, 1);

    for (let i = 0; i < 50; i += 1) writer.record(envelope(i));
    await writer.flush();

    const gaps = (await repo.list()).filter((r) => r.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.droppedCount).toBe(49);
  });

  it("spans the gap marker across the interval that was lost", async () => {
    const repo = new InMemoryActivityRepository();
    const writer = makeWriter(repo, 1);

    writer.record(envelope(0)); // buffered
    writer.record(envelope(10)); // dropped
    writer.record(envelope(20)); // dropped
    await writer.flush();

    const gap = (await repo.list()).find((r) => r.kind === "gap");
    expect(gap?.gapFrom?.toISOString()).toBe("2026-08-17T12:00:10.000Z");
    expect(gap?.gapTo?.toISOString()).toBe("2026-08-17T12:00:20.000Z");
  });

  it("contains a write failure and reports it as a gap once storage recovers", async () => {
    const repo = new InMemoryActivityRepository();
    const errors: unknown[] = [];
    const writer = new ActivityWriter(repo, {
      maxBuffer: 100,
      batchSize: 10,
      flushIntervalMs: 0,
      onError: (e) => errors.push(e),
    });

    repo.appendHook = (): never => {
      throw new Error("storage down");
    };
    for (let i = 0; i < 3; i += 1) writer.record(envelope(i));
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(await repo.list()).toHaveLength(0);

    // Storage recovers: the loss is still reported rather than forgotten.
    repo.appendHook = null;
    writer.record(envelope(9));
    await writer.flush();

    const stored = await repo.list();
    const gap = stored.find((r) => r.kind === "gap");
    expect(gap).toBeDefined();
    expect(gap?.droppedCount).toBe(3);
    expect(gap?.reason).toMatch(/append failed/);
  });

  it("keeps the gap marker pending while storage stays down", async () => {
    const repo = new InMemoryActivityRepository();
    const writer = new ActivityWriter(repo, {
      maxBuffer: 100,
      batchSize: 10,
      flushIntervalMs: 0,
      onError: () => {},
    });
    repo.appendHook = (): never => {
      throw new Error("still down");
    };

    writer.record(envelope(1));
    await writer.flush();
    await writer.flush();
    expect(await repo.list()).toHaveLength(0);

    repo.appendHook = null;
    await writer.flush();
    const gaps = (await repo.list()).filter((r) => r.kind === "gap");
    expect(gaps).toHaveLength(1);
  });

  it("serializes concurrent flushes into one chain", async () => {
    const repo = new InMemoryActivityRepository();
    const writer = makeWriter(repo);

    for (let i = 0; i < 30; i += 1) writer.record(envelope(i));
    await Promise.all([writer.flush(), writer.flush(), writer.flush()]);

    const stored = await repo.list();
    expect(stored).toHaveLength(30);
    expect(await repo.verify()).toMatchObject({ ok: true });
  });

  it("flushes what is buffered on close", async () => {
    const repo = new InMemoryActivityRepository();
    const writer = makeWriter(repo);
    writer.record(envelope(1));

    await writer.close();

    expect(await repo.list()).toHaveLength(1);
    // After close it stops accepting, rather than buffering records nobody drains.
    writer.record(envelope(2));
    expect(writer.pending).toBe(0);
  });
});

describe("activity writer — the timer and the losses", () => {
  it("flushes on its own when an interval is set", async () => {
    // Every other test drives `flush()` by hand. In the product nothing does,
    // so the timer is the only thing that ever writes anything.
    const repo = new InMemoryActivityRepository();
    const writer = new ActivityWriter(repo, { flushIntervalMs: 5 });
    writer.record(envelope(1));

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await repo.list()).toHaveLength(1);
    await writer.close();
  });

  it("stops the timer on close, and writes what was still buffered", async () => {
    const repo = new InMemoryActivityRepository();
    const writer = new ActivityWriter(repo, { flushIntervalMs: 5 });
    writer.record(envelope(2));
    await writer.close();

    expect(await repo.list()).toHaveLength(1);
    // Closed: further records are dropped rather than buffered forever.
    writer.record(envelope(3));
    await writer.flush();
    expect(await repo.list()).toHaveLength(1);
  });

  it("flushes nothing without touching the store", async () => {
    const repo = new InMemoryActivityRepository();
    const writer = makeWriter(repo);
    await writer.flush();
    expect(await repo.list()).toEqual([]);
  });

  it("merges consecutive losses into one marker rather than one per record", async () => {
    // A marker per dropped record would flood the buffer it is reporting on,
    // which is the condition that caused the loss.
    const repo = new InMemoryActivityRepository();
    const writer = new ActivityWriter(repo, { maxBuffer: 1, batchSize: 10, flushIntervalMs: 0 });

    writer.record(envelope(1));
    writer.record(envelope(2));
    writer.record(envelope(3));
    writer.record(envelope(4));
    await writer.flush();

    const gaps = (await repo.list()).filter((r) => r.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.droppedCount).toBe(3);
  });

  it("names both reasons when losses of two kinds run together", async () => {
    const repo = new InMemoryActivityRepository();
    let fail = true;
    const flaky = {
      ...repo,
      append: async (batch: ActivityRecordInput[]) => {
        if (fail) throw new Error("the store is down");
        return repo.append(batch);
      },
      list: repo.list.bind(repo),
    } as unknown as InMemoryActivityRepository;

    const writer = new ActivityWriter(flaky, { maxBuffer: 1, batchSize: 10, flushIntervalMs: 0 });
    writer.record(envelope(1));
    writer.record(envelope(2));
    await writer.flush();

    fail = false;
    writer.record(envelope(3));
    await writer.flush();

    const gaps = (await repo.list()).filter((r) => r.kind === "gap");
    expect(gaps).toHaveLength(1);
    const reason = String(gaps[0]!.reason ?? "");
    expect(reason).toMatch(/buffer full/);
    expect(reason).toMatch(/append failed/);
  });

  it("keeps the gap marker when the flush that carried it failed", async () => {
    // The batch is gone AND the marker reporting it is gone. Accounting for
    // both means the next successful flush still reports the loss, rather than
    // the log quietly showing no gap at all.
    const repo = new InMemoryActivityRepository();
    let fail = true;
    const flaky = {
      append: async (batch: ActivityRecordInput[]) => {
        if (fail) throw new Error("down");
        return repo.append(batch);
      },
      list: repo.list.bind(repo),
    } as unknown as InMemoryActivityRepository;

    const writer = new ActivityWriter(flaky, { maxBuffer: 1, batchSize: 10, flushIntervalMs: 0 });
    writer.record(envelope(1));
    writer.record(envelope(2));
    await writer.flush();

    fail = false;
    writer.record(envelope(3));
    await writer.flush();

    expect((await repo.list()).some((r) => r.kind === "gap")).toBe(true);
  });
});
