import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { GroupingMember } from "./auto-groups.js";
import { InMemoryMessagesRepository } from "./repository.memory.js";
import { MessagesService } from "./service.js";

/**
 * Reconciling a company's auto-created groups against the plan.
 *
 * The SPA fires this after adding a user, so it runs many times over the life of
 * a deal. Everything here is about it being safe to run again: no duplicate
 * rooms, no member silently removed, and nothing done to a group somebody
 * created by hand.
 */

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

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

const grouping = (over: Partial<GroupingMember> & { id: string }): GroupingMember => ({
  role: "buyer",
  subRole: null,
  parentUserId: null,
  name: null,
  brokerCompany: null,
  buyerCompanyName: null,
  ...over,
});

/** A company with a broker, a client and one buyer firm. */
function make(members: GroupingMember[] = defaultMembers()) {
  const repo = new InMemoryMessagesRepository();
  repo.seedCompany({ id: COMPANY, name: "Acme" });
  repo.setGroupingMembers(COMPANY, members);
  return { repo, service: new MessagesService({ repo }) };
}

const defaultMembers = (): GroupingMember[] => [
  grouping({ id: "broker-1", role: "broker", subRole: "broker_primary", brokerCompany: "Kestrel" }),
  grouping({ id: "client-1", subRole: "company_owner" }),
  grouping({ id: "buyer-1", subRole: "buyer_primary", buyerCompanyName: "Northwind" }),
];

describe("creating", () => {
  it("creates the planned groups and reports them", async () => {
    const { repo, service } = make();

    const result = await service.autoCreateGroups(session(), COMPANY);

    expect(result.success).toBe(true);
    expect(result.created.map((c) => c.groupType).sort()).toEqual([
      "broker_buyer",
      "broker_client",
      "deal_team",
    ]);
    const groups = await repo.listGroupsByCompany(COMPANY);
    expect(groups.map((g) => g.name).sort()).toEqual([
      "DealTeam - Acme",
      "Kestrel - Acme",
      "Kestrel - Northwind",
    ]);
  });

  it("marks what it creates as auto-created", async () => {
    // The flag is how the UI tells a generated room from one a person made.
    const { repo, service } = make();
    await service.autoCreateGroups(session(), COMPANY);
    expect((await repo.listGroupsByCompany(COMPANY)).every((g) => g.autoCreated)).toBe(true);
  });

  it("puts the planned members in each group", async () => {
    const { repo, service } = make();
    await service.autoCreateGroups(session(), COMPANY);

    const groups = await repo.listGroupsByCompany(COMPANY);
    const channel = groups.find((g) => g.groupType === "broker_buyer")!;
    expect((await repo.listMembers(channel.id)).sort()).toEqual(["broker-1", "buyer-1"]);
    // The client must not be in a buyer channel.
    expect(await repo.listMembers(channel.id)).not.toContain("client-1");
  });

  it("creates nothing for a company with no classifiable members", async () => {
    const { repo, service } = make([]);
    expect((await service.autoCreateGroups(session(), COMPANY)).created).toEqual([]);
    expect(await repo.listGroupsByCompany(COMPANY)).toEqual([]);
  });
});

describe("running it again", () => {
  it("creates no duplicates", async () => {
    const { repo, service } = make();
    await service.autoCreateGroups(session(), COMPANY);

    const second = await service.autoCreateGroups(session(), COMPANY);

    expect(second.created).toEqual([]);
    expect(await repo.listGroupsByCompany(COMPANY)).toHaveLength(3);
  });

  it("renames a group when the firm name changes, rather than making a new one", async () => {
    const members = defaultMembers();
    const { repo, service } = make(members);
    await service.autoCreateGroups(session(), COMPANY);

    members[0]!.brokerCompany = "Kestrel Partners";
    repo.setGroupingMembers(COMPANY, members);
    await service.autoCreateGroups(session(), COMPANY);

    const groups = await repo.listGroupsByCompany(COMPANY);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.name).sort()).toEqual([
      "DealTeam - Acme",
      "Kestrel Partners - Acme",
      "Kestrel Partners - Northwind",
    ]);
  });

  it("adds a newly-joined member to the existing rooms", async () => {
    const members = defaultMembers();
    const { repo, service } = make(members);
    await service.autoCreateGroups(session(), COMPANY);

    repo.setGroupingMembers(COMPANY, [
      ...members,
      grouping({ id: "client-2", subRole: "client_team_member" }),
    ]);
    await service.autoCreateGroups(session(), COMPANY);

    const dealTeam = (await repo.listGroupsByCompany(COMPANY)).find(
      (g) => g.groupType === "deal_team",
    )!;
    expect(await repo.listMembers(dealTeam.id)).toContain("client-2");
  });

  it("does not remove a member who is no longer in the plan", async () => {
    // Leaving a room is a decision; reconciliation must not silently undo it,
    // and it must not evict someone because their sub-role was edited.
    const members = defaultMembers();
    const { repo, service } = make(members);
    await service.autoCreateGroups(session(), COMPANY);

    repo.setGroupingMembers(COMPANY, members.filter((m) => m.id !== "client-1"));
    await service.autoCreateGroups(session(), COMPANY);

    const dealTeam = (await repo.listGroupsByCompany(COMPANY)).find(
      (g) => g.groupType === "deal_team",
    )!;
    expect(await repo.listMembers(dealTeam.id)).toContain("client-1");
  });

  it("creates a new buyer channel when a second firm arrives, leaving the first alone", async () => {
    const members = defaultMembers();
    const { repo, service } = make(members);
    await service.autoCreateGroups(session(), COMPANY);

    repo.setGroupingMembers(COMPANY, [
      ...members,
      grouping({ id: "buyer-2", subRole: "buyer_primary", buyerCompanyName: "Southgate" }),
    ]);
    const second = await service.autoCreateGroups(session(), COMPANY);

    expect(second.created.map((c) => c.groupType)).toEqual(["broker_buyer"]);
    const channels = (await repo.listGroupsByCompany(COMPANY)).filter(
      (g) => g.groupType === "broker_buyer",
    );
    expect(channels.map((g) => g.name).sort()).toEqual(["Kestrel - Northwind", "Kestrel - Southgate"]);
  });

  it("leaves a hand-made group untouched", async () => {
    const { repo, service } = make();
    const manual = await repo.createGroup({
      companyId: COMPANY,
      name: "Lawyers only",
      groupType: "client_internal",
      buyerUserId: null,
      autoCreated: false,
      memberIds: ["client-1"],
    });

    await service.autoCreateGroups(session(), COMPANY);

    const after = (await repo.listGroupsByCompany(COMPANY)).find((g) => g.id === manual.id)!;
    expect(after).toMatchObject({ name: "Lawyers only", autoCreated: false });
    expect(await repo.listMembers(manual.id)).toEqual(["client-1"]);
  });
});

describe("authorization", () => {
  it("refuses a company the caller is not on", async () => {
    const { service } = make();
    await expect(
      service.autoCreateGroups(session({ company_ids: [OTHER] }), COMPANY),
    ).rejects.toThrow(ForbiddenError);
  });

  it("404s a company that does not exist", async () => {
    const repo = new InMemoryMessagesRepository();
    const service = new MessagesService({ repo });
    await expect(service.autoCreateGroups(session(), COMPANY)).rejects.toThrow(NotFoundError);
  });

  it("allows a client to trigger it, not only a broker", async () => {
    // Legacy narrowed this to brokers and then deliberately opened it up: a
    // client who cannot regenerate groups has no rooms to talk in.
    const { service } = make();
    const client = session({ role: "buyer", company_ids: [COMPANY] });
    expect((await service.autoCreateGroups(client, COMPANY)).success).toBe(true);
  });
});
