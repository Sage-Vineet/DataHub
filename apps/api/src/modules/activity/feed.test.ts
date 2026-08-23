import { describe, expect, it } from "vitest";
import {
  asIsoDate,
  buildBrokerFeed,
  clampLimit,
  DEFAULT_ACTIVITY_LIMIT,
  MAX_ACTIVITY_LIMIT,
  type BrokerActivitySources,
} from "./feed.js";

/**
 * Merging six tables into one story.
 *
 * Two properties carry the weight. The order must be *total* — bulk writes land
 * in the same second constantly, and without a tiebreak the feed reshuffles
 * between identical requests. And a non-admin must never see a request title
 * from a company they are not on, which is decided here by whether the
 * narrative's request resolved.
 */

const sources = (over: Partial<BrokerActivitySources> = {}): BrokerActivitySources => ({
  companies: [],
  buyers: [],
  documents: [],
  requests: [],
  narratives: [],
  activityLog: [],
  requestById: new Map(),
  companyNameById: new Map(),
  userNameById: new Map(),
  ...over,
});

const build = (s: BrokerActivitySources, isAdmin = true, limit = 100) =>
  buildBrokerFeed(s, { isAdmin, limit });

describe("clamping the limit", () => {
  it("falls back to the default for anything unreadable", () => {
    for (const bad of [undefined, null, "", "abc", "0", "-5", {}]) {
      expect(clampLimit(bad)).toBe(DEFAULT_ACTIVITY_LIMIT);
    }
  });

  it("caps an outsized request rather than honouring it", () => {
    expect(clampLimit("100000")).toBe(MAX_ACTIVITY_LIMIT);
  });

  it("honours a sensible one", () => {
    expect(clampLimit("25")).toBe(25);
  });
});

describe("reading timestamps", () => {
  it("normalizes to ISO", () => {
    expect(asIsoDate("2024-03-01T10:00:00Z")).toBe("2024-03-01T10:00:00.000Z");
  });

  it("returns null for anything it cannot read", () => {
    expect(asIsoDate(null)).toBeNull();
    expect(asIsoDate("")).toBeNull();
    expect(asIsoDate("not a date")).toBeNull();
  });
});

describe("building the feed", () => {
  it("labels each source in the shape the dashboard renders", () => {
    const feed = build(
      sources({
        companies: [
          { id: "c1", name: "Acme Ltd", projectName: "Project Falcon", industry: "Manufacturing", createdAt: "2024-01-01T00:00:00Z" },
        ],
        documents: [
          { id: "d1", name: "Q1.pdf", companyId: "c1", uploadedBy: "u1", uploadedAt: "2024-01-02T00:00:00Z" },
        ],
        companyNameById: new Map([["c1", "Project Falcon"]]),
        userNameById: new Map([["u1", "Dana"]]),
      }),
    );

    expect(feed.map((e) => e.type)).toEqual(["document_uploaded", "company_created"]);
    expect(feed[0]).toMatchObject({
      message: "Document uploaded: Q1.pdf",
      detail: "Project Falcon",
      actor_name: "Dana",
      sequence: 1,
    });
    // The project name is what a broker calls the deal.
    expect(feed[1]!.message).toBe("Company added: Project Falcon");
  });

  it("drops an event with no readable timestamp rather than placing it arbitrarily", () => {
    const feed = build(
      sources({
        companies: [{ id: "c1", name: "A", projectName: null, industry: null, createdAt: null }],
        requests: [{ id: "r1", title: "T", companyId: "c1", createdBy: null, createdAt: "bad" }],
      }),
    );
    expect(feed).toEqual([]);
  });

  it("orders newest first", () => {
    const feed = build(
      sources({
        requests: [
          { id: "old", title: "Old", companyId: "c1", createdBy: null, createdAt: "2024-01-01T00:00:00Z" },
          { id: "new", title: "New", companyId: "c1", createdBy: null, createdAt: "2024-06-01T00:00:00Z" },
        ],
      }),
    );
    expect(feed.map((e) => e.message)).toEqual(["Request created: New", "Request created: Old"]);
  });

  it("breaks a timestamp tie by event kind, so the order is stable", () => {
    // A company import writes several tables in the same second. Without this
    // the feed reshuffles between two identical requests.
    const at = "2024-01-01T00:00:00Z";
    const feed = build(
      sources({
        documents: [{ id: "d", name: "D", companyId: "c", uploadedBy: null, uploadedAt: at }],
        requests: [{ id: "r", title: "R", companyId: "c", createdBy: null, createdAt: at }],
        companies: [{ id: "c", name: "C", projectName: null, industry: null, createdAt: at }],
      }),
    );
    expect(feed.map((e) => e.type)).toEqual([
      "company_created",
      "request_created",
      "document_uploaded",
    ]);
  });

  it("falls back to the id when kind and timestamp both tie", () => {
    const at = "2024-01-01T00:00:00Z";
    const feed = build(
      sources({
        requests: [
          { id: "b", title: "B", companyId: "c", createdBy: null, createdAt: at },
          { id: "a", title: "A", companyId: "c", createdBy: null, createdAt: at },
        ],
      }),
    );
    expect(feed.map((e) => e.id)).toEqual(["request-created-a", "request-created-b"]);
  });

  it("numbers the returned page from one", () => {
    const feed = build(
      sources({
        requests: [
          { id: "a", title: "A", companyId: "c", createdBy: null, createdAt: "2024-01-02T00:00:00Z" },
          { id: "b", title: "B", companyId: "c", createdBy: null, createdAt: "2024-01-01T00:00:00Z" },
        ],
      }),
    );
    expect(feed.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("applies the limit after sorting, not before", () => {
    const feed = build(
      sources({
        requests: [
          { id: "old", title: "Old", companyId: "c", createdBy: null, createdAt: "2024-01-01T00:00:00Z" },
          { id: "new", title: "New", companyId: "c", createdBy: null, createdAt: "2024-06-01T00:00:00Z" },
        ],
      }),
      true,
      1,
    );
    expect(feed.map((e) => e.message)).toEqual(["Request created: New"]);
  });

  it("deduplicates a row that reaches the feed twice", () => {
    // An upload writes `documents` and `activity_log` both.
    const feed = build(
      sources({
        activityLog: [
          { id: "x", type: "activity", message: "one", companyId: "c", createdBy: null, createdAt: "2024-01-01T00:00:00Z" },
          { id: "x", type: "activity", message: "one again", companyId: "c", createdBy: null, createdAt: "2024-01-01T00:00:00Z" },
        ],
      }),
    );
    expect(feed).toHaveLength(1);
  });

  it("falls back through the naming chain rather than rendering a blank", () => {
    const feed = build(
      sources({
        buyers: [{ id: "u", name: null, email: "b@x.com", companyId: null, createdAt: "2024-01-01T00:00:00Z" }],
        documents: [{ id: "d", name: null, companyId: null, uploadedBy: null, uploadedAt: "2024-01-01T00:00:00Z" }],
        requests: [{ id: "r", title: null, companyId: null, createdBy: null, createdAt: "2024-01-01T00:00:00Z" }],
        activityLog: [{ id: "l", type: null, message: null, companyId: null, createdBy: null, createdAt: "2024-01-01T00:00:00Z" }],
      }),
    );
    const byType = new Map(feed.map((e) => [e.type, e.message]));
    expect(byType.get("user_added")).toBe("Client added: b@x.com");
    expect(byType.get("document_uploaded")).toBe("Document uploaded: Document");
    expect(byType.get("request_created")).toBe("Request created: Untitled");
    expect(byType.get("activity")).toBe("Activity recorded");
  });
});

describe("what a non-admin may see", () => {
  const withNarrative = sources({
    narratives: [{ id: "n1", requestId: "r-elsewhere", updatedBy: null, updatedAt: "2024-01-01T00:00:00Z" }],
  });

  it("hides a narrative whose request is outside their companies", () => {
    // The request did not resolve, which is precisely how "not yours" is
    // signalled — rendering it would leak another tenant's request title.
    expect(build(withNarrative, false)).toEqual([]);
  });

  it("shows an admin the same narrative, unresolved title and all", () => {
    const feed = build(withNarrative, true);
    expect(feed).toHaveLength(1);
    expect(feed[0]!.message).toBe("Request answered: Untitled request");
  });

  it("shows a resolved narrative to anyone", () => {
    const resolved = sources({
      narratives: [{ id: "n1", requestId: "r1", updatedBy: "u1", updatedAt: "2024-01-01T00:00:00Z" }],
      requestById: new Map([["r1", { title: "Send Q1", companyId: "c1" }]]),
      companyNameById: new Map([["c1", "Acme"]]),
      userNameById: new Map([["u1", "Dana"]]),
    });

    expect(build(resolved, false)[0]).toMatchObject({
      message: "Request answered: Send Q1",
      detail: "Acme",
      actor_name: "Dana",
    });
  });
});
