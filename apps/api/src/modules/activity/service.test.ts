import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { ForbiddenError } from "../../shared/errors.js";
import { DEFAULT_ACTIVITY_LIMIT, PER_SOURCE_LIMIT } from "./feed.js";
import { InMemoryActivityRepository } from "./repository.memory.js";
import { ActivityService } from "./service.js";

/**
 * The service's job is the guard and the scope: who may ask, and what the
 * repository is told they can see. The merging is tested against
 * `buildBrokerFeed` directly.
 */

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(),
  name: "U",
  email: "u@x.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
  ...over,
});

function make() {
  const repo = new InMemoryActivityRepository();
  return { repo, service: new ActivityService({ repo }) };
}

describe("who may read the feed", () => {
  it("refuses a client", async () => {
    const { service, repo } = make();
    await expect(service.brokerFeed(session({ role: "buyer" }), undefined)).rejects.toThrow(
      ForbiddenError,
    );
    // Refused before any query ran.
    expect(repo.lastScope).toBeNull();
  });

  it("allows a broker and an admin", async () => {
    const { service } = make();
    await expect(service.brokerFeed(session(), undefined)).resolves.toEqual([]);
    await expect(
      service.brokerFeed(session({ role: "admin", company_ids: [] }), undefined),
    ).resolves.toEqual([]);
  });

  it("is not fooled by casing", async () => {
    const { service } = make();
    await expect(
      service.brokerFeed(session({ role: "BROKER" as SessionUser["role"] }), undefined),
    ).resolves.toEqual([]);
  });
});

describe("the scope it asks for", () => {
  it("passes the broker's companies and marks them non-admin", async () => {
    const { repo, service } = make();
    await service.brokerFeed(session(), undefined);
    expect(repo.lastScope).toEqual({ isAdmin: false, companyIds: [COMPANY] });
    expect(repo.lastPerSource).toBe(PER_SOURCE_LIMIT);
  });

  it("marks an admin unscoped", async () => {
    const { repo, service } = make();
    await service.brokerFeed(session({ role: "admin", company_ids: [] }), undefined);
    expect(repo.lastScope).toMatchObject({ isAdmin: true });
  });

  it("skips the query entirely for a broker with no companies", async () => {
    // Six tables queried with an empty `IN ()` to prove there is nothing.
    const { repo, service } = make();
    expect(await service.brokerFeed(session({ company_ids: [] }), undefined)).toEqual([]);
    expect(repo.lastScope).toBeNull();
  });
});

describe("the limit", () => {
  it("clamps a caller-supplied value", async () => {
    const { repo, service } = make();
    repo.seed({
      requests: Array.from({ length: 5 }, (_, i) => ({
        id: `r${i}`,
        title: `R${i}`,
        companyId: COMPANY,
        createdBy: null,
        createdAt: `2024-01-0${i + 1}T00:00:00Z`,
      })),
    });

    expect(await service.brokerFeed(session(), "2")).toHaveLength(2);
    expect(await service.brokerFeed(session(), "nonsense")).toHaveLength(5);
  });

  it("defaults when none is given", async () => {
    const { repo, service } = make();
    repo.seed({
      requests: Array.from({ length: 3 }, (_, i) => ({
        id: `r${i}`,
        title: `R${i}`,
        companyId: COMPANY,
        createdBy: null,
        createdAt: "2024-01-01T00:00:00Z",
      })),
    });
    const feed = await service.brokerFeed(session(), undefined);
    expect(feed.length).toBeLessThanOrEqual(DEFAULT_ACTIVITY_LIMIT);
    expect(feed).toHaveLength(3);
  });
});
