import { describe, expect, it } from "vitest";
import { canonicalize, contentHashOf } from "./hash.js";
import { InMemoryActivityRepository } from "./repository.memory.js";
import { blankRecord, type ActivityRecordInput } from "./types.js";

function envelope(path: string, at = new Date("2026-08-17T12:00:00Z")): ActivityRecordInput {
  const record = blankRecord("envelope", at);
  record.correlationId = "0f1e2d3c-4b5a-4968-8776-655443332211";
  record.engine = "legacy";
  record.method = "GET";
  record.rawPath = path;
  record.path = path;
  record.status = 200;
  record.durationMs = 3;
  return record;
}

describe("canonical serialization", () => {
  it("is independent of key order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("sorts nested keys too", () => {
    expect(canonicalize({ x: { b: 1, a: 2 } })).toBe(canonicalize({ x: { a: 2, b: 1 } }));
  });

  it("serializes dates as instants, not locale strings", () => {
    expect(canonicalize(new Date("2026-08-17T12:00:00Z"))).toBe('"2026-08-17T12:00:00.000Z"');
  });
});

describe("content hash", () => {
  it("changes when any field changes", () => {
    const record = envelope("/a");
    const base = contentHashOf(record, 1, null);
    expect(contentHashOf({ ...record, status: 201 }, 1, null)).not.toBe(base);
    expect(contentHashOf(record, 2, null)).not.toBe(base);
    expect(contentHashOf(record, 1, "deadbeef")).not.toBe(base);
  });

  it("is stable for identical input", () => {
    const record = envelope("/a");
    expect(contentHashOf(record, 1, null)).toBe(contentHashOf(envelope("/a"), 1, null));
  });
});

describe("chain verification", () => {
  it("verifies an intact chain", async () => {
    const repo = new InMemoryActivityRepository();
    await repo.append([envelope("/a"), envelope("/b"), envelope("/c")]);

    const result = await repo.verify();
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(3);
    expect(result.broken_at_seq).toBeNull();
  });

  it("links each record to its predecessor", async () => {
    const repo = new InMemoryActivityRepository();
    await repo.append([envelope("/a"), envelope("/b")]);
    const [first, second] = await repo.list();

    expect(first?.prevHash).toBeNull();
    expect(second?.prevHash).toBe(first?.contentHash);
  });

  it("detects a record altered after it was written", async () => {
    const repo = new InMemoryActivityRepository();
    await repo.append([envelope("/a"), envelope("/b"), envelope("/c")]);

    repo.tamper(2, (record) => {
      record.path = "/tampered";
    });

    const result = await repo.verify();
    expect(result.ok).toBe(false);
    expect(result.broken_at_seq).toBe(2);
    expect(result.reason).toMatch(/altered/);
  });

  it("detects a record removed out of band", async () => {
    const repo = new InMemoryActivityRepository();
    await repo.append([envelope("/a"), envelope("/b"), envelope("/c")]);

    repo.remove(2);

    const result = await repo.verify();
    expect(result.ok).toBe(false);
    expect(result.broken_at_seq).toBe(3);
    expect(result.reason).toMatch(/removed/);
  });

  it("detects tampering that preserves the sequence but breaks the link", async () => {
    const repo = new InMemoryActivityRepository();
    await repo.append([envelope("/a"), envelope("/b")]);

    // Re-hash the altered record so its own content hash is self-consistent —
    // the link to its predecessor is what still gives it away.
    repo.tamper(2, (record) => {
      record.path = "/tampered";
      record.prevHash = "0".repeat(64);
      record.contentHash = contentHashOf(record, 2, record.prevHash);
    });

    const result = await repo.verify();
    expect(result.ok).toBe(false);
    expect(result.broken_at_seq).toBe(2);
    expect(result.reason).toMatch(/prev_hash/);
  });

  it("exposes no mutation path on the repository itself", () => {
    const repo = new InMemoryActivityRepository();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));
    expect(surface).not.toContain("update");
    expect(surface).not.toContain("delete");
  });
});
