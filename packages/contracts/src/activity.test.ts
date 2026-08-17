import { describe, expect, it } from "vitest";
import {
  activityEnvelope,
  activityEventType,
  activityGapMarker,
  activitySemanticEvent,
  activityVerification,
} from "./activity.js";

const baseEnvelope = {
  correlation_id: "0f1e2d3c-4b5a-4968-8776-655443332211",
  occurred_at: new Date("2026-08-17T12:00:00Z"),
  actor_id: "user-1",
  actor_kind: "user" as const,
  engine: "legacy" as const,
  method: "GET",
  raw_path: "/companies/42",
  path: "/companies/:id",
  status: 200,
  duration_ms: 12,
  ip: "203.0.113.7",
  user_agent: "vitest",
};

describe("activity envelope contract", () => {
  it("accepts transport metadata", () => {
    expect(activityEnvelope.safeParse(baseEnvelope).success).toBe(true);
  });

  // The capture path must never carry request or response bodies (design D2):
  // reading a body at the gateway would consume the stream and forward a
  // body-less request to legacy. A strict schema turns that rule into a test.
  it("rejects any attempt to carry body content", () => {
    for (const extra of [
      { body: { secret: "value" } },
      { request_body: "x" },
      { response_body: "y" },
      { payload: { anything: true } },
    ]) {
      const result = activityEnvelope.safeParse({ ...baseEnvelope, ...extra });
      expect(result.success).toBe(false);
    }
  });

  it("requires a status and a non-negative duration", () => {
    expect(activityEnvelope.safeParse({ ...baseEnvelope, status: undefined }).success).toBe(false);
    expect(activityEnvelope.safeParse({ ...baseEnvelope, duration_ms: -1 }).success).toBe(false);
  });

  it("allows an anonymous actor", () => {
    const parsed = activityEnvelope.safeParse({
      ...baseEnvelope,
      actor_id: null,
      actor_kind: "anonymous",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("activity semantic event contract", () => {
  it("accepts a declared event type with a payload", () => {
    const parsed = activitySemanticEvent.safeParse({
      correlation_id: baseEnvelope.correlation_id,
      occurred_at: new Date(),
      actor_id: "user-1",
      actor_kind: "user",
      event_type: "access.granted",
      subject_id: "user-2",
      company_id: "11111111-2222-4333-8444-555566667777",
      payload: { scope: "folder" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an undeclared event type", () => {
    expect(activityEventType.safeParse("access.somethingelse").success).toBe(false);
  });
});

describe("activity gap marker contract", () => {
  it("requires a positive dropped count and a reason", () => {
    const base = {
      occurred_at: new Date(),
      gap_from: new Date("2026-08-17T14:02:00Z"),
      gap_to: new Date("2026-08-17T14:03:00Z"),
      reason: "capture buffer full",
    };
    expect(activityGapMarker.safeParse({ ...base, dropped_count: 1840 }).success).toBe(true);
    expect(activityGapMarker.safeParse({ ...base, dropped_count: 0 }).success).toBe(false);
  });
});

describe("verification result contract", () => {
  it("carries the breaking sequence number when it fails", () => {
    const parsed = activityVerification.safeParse({
      ok: false,
      checked: 10,
      broken_at_seq: 4,
      reason: "content hash does not match",
    });
    expect(parsed.success).toBe(true);
  });
});
