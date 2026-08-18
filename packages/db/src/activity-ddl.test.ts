import { describe, expect, it } from "vitest";
import {
  activityGrantsDdl,
  activityTablesDdl,
  monthlyPartitionDdl,
  partitionBounds,
  partitionSuffix,
  upcomingPartitionsDdl,
} from "./activity-ddl.js";
import { activityChainHead, activityEvents } from "./schema.js";

describe("activity table declaration", () => {
  it("declares the columns capture writes", () => {
    const columns = Object.keys(activityEvents);
    for (const name of [
      "seq",
      "occurredAt",
      "kind",
      "correlationId",
      "actorId",
      "actorKind",
      "engine",
      "method",
      "rawPath",
      "path",
      "status",
      "durationMs",
      "ip",
      "userAgent",
      "eventType",
      "subjectId",
      "companyId",
      "payload",
      "droppedCount",
      "gapFrom",
      "gapTo",
      "reason",
      "contentHash",
      "prevHash",
    ]) {
      expect(columns).toContain(name);
    }
  });

  it("declares the chain head", () => {
    expect(Object.keys(activityChainHead)).toEqual(
      expect.arrayContaining(["id", "lastSeq", "lastHash"]),
    );
  });
});

describe("partition DDL", () => {
  it("computes half-open month bounds", () => {
    expect(partitionBounds(2026, 8)).toEqual({ from: "2026-08-01", to: "2026-09-01" });
  });

  it("rolls the year over in December", () => {
    expect(partitionBounds(2026, 12)).toEqual({ from: "2026-12-01", to: "2027-01-01" });
  });

  it("zero-pads the suffix", () => {
    expect(partitionSuffix(2026, 3)).toBe("2026_03");
  });

  it("emits idempotent partition DDL", () => {
    const ddl = monthlyPartitionDdl(2026, 8);
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS activity_events_2026_08");
    expect(ddl).toContain("FOR VALUES FROM ('2026-08-01') TO ('2026-09-01')");
  });

  it("rejects an out-of-range month rather than emitting broken DDL", () => {
    expect(() => monthlyPartitionDdl(2026, 13)).toThrow(/month must be 1-12/);
  });

  it("covers the current month plus the requested lookahead", () => {
    const ddl = upcomingPartitionsDdl(new Date("2026-11-15T00:00:00Z"), 2);
    expect(ddl).toContain("activity_events_2026_11");
    expect(ddl).toContain("activity_events_2026_12");
    expect(ddl).toContain("activity_events_2027_01");
  });
});

describe("table DDL", () => {
  const ddl = activityTablesDdl();

  it("partitions by occurred_at", () => {
    expect(ddl).toContain("PARTITION BY RANGE (occurred_at)");
  });

  // Without a default partition, a month nobody rolled forward turns into
  // dropped audit records — the exact failure the capability exists to prevent.
  it("always declares a default partition", () => {
    expect(ddl).toContain("activity_events_default PARTITION OF activity_events DEFAULT");
  });

  it("seeds the chain head", () => {
    expect(ddl).toContain("INSERT INTO activity_chain_head (id, last_seq, last_hash)");
    expect(ddl).toContain("ON CONFLICT (id) DO NOTHING");
  });
});

describe("grants", () => {
  const ddl = activityGrantsDdl("datahub_app");

  it("grants insert and select but never update or delete on the log", () => {
    expect(ddl).toContain("GRANT SELECT, INSERT ON activity_events TO datahub_app");
    expect(ddl).not.toMatch(/GRANT[^;]*UPDATE[^;]*ON activity_events/);
    expect(ddl).not.toMatch(/GRANT[^;]*DELETE[^;]*ON activity_events/);
  });

  it("allows the chain head to be updated — it is state, not history", () => {
    expect(ddl).toContain("GRANT SELECT, INSERT, UPDATE ON activity_chain_head TO datahub_app");
  });

  it("refuses an unsafe role name rather than interpolating it", () => {
    expect(() => activityGrantsDdl("app; DROP TABLE activity_events; --")).toThrow(/unsafe role/);
  });
});
