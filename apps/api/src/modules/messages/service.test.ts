import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { messages as contracts, type SessionUser } from "@datahub/contracts";
import { ForbiddenError } from "../../shared/errors.js";
import { InMemoryMessagesRepository } from "./repository.memory.js";
import { MessagesService } from "./service.js";

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function make() {
  const repo = new InMemoryMessagesRepository();
  return { repo, service: new MessagesService({ repo }) };
}
const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(), name: "U", email: "u@x.com", role: "broker", company_id: null, status: "active", company_ids: [COMPANY], ...over,
});

describe("MessagesService — company + direct", () => {
  it("posts/reads a company conversation and denies cross-tenant", async () => {
    const { service } = make();
    const user = session();
    await service.companySend(user, COMPANY, "hello team");
    expect((await service.companyList(user, COMPANY)).map((m) => m.body)).toEqual(["hello team"]);
    await expect(service.companyList(session({ role: "buyer", company_ids: [OTHER] }), COMPANY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("direct conversation is symmetric", async () => {
    const { service } = make();
    const a = session();
    const b = session();
    await service.directSend(a, COMPANY, b.id, "hi B");
    await service.directSend(b, COMPANY, a.id, "hi A");
    const asA = await service.directList(a, COMPANY, b.id);
    const asB = await service.directList(b, COMPANY, a.id);
    expect(asA.map((m) => m.body)).toEqual(["hi B", "hi A"]);
    expect(asB.map((m) => m.body)).toEqual(["hi B", "hi A"]);
  });
});

describe("MessagesService — groups", () => {
  it("creates a group (creator is a member), manages membership, and restricts to members", async () => {
    const { service } = make();
    const broker = session();
    const group = await service.createGroup(broker, COMPANY, contracts.groupCreate.parse({ name: "Deal Team", group_type: "deal_team" }));
    expect(group.auto_created).toBe(false);
    expect(await service.listMembers(broker, group.id)).toContain(broker.id);

    // A non-member client cannot read the group.
    const client = session({ role: "buyer", company_ids: [COMPANY] });
    await expect(service.groupMessages(client, group.id)).rejects.toBeInstanceOf(ForbiddenError);

    // Add the client → now a member → can read/post.
    await service.addMember(broker, group.id, client.id);
    await service.sendGroupMessage(client, group.id, "hi from client");
    expect((await service.groupMessages(client, group.id)).length).toBe(1);

    // A client cannot create a group.
    await expect(service.createGroup(client, COMPANY, contracts.groupCreate.parse({ name: "x", group_type: "deal_team" }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("unread-count follows the read watermark", async () => {
    const { service } = make();
    const a = session();
    const b = session();
    const group = await service.createGroup(a, COMPANY, contracts.groupCreate.parse({ name: "G", group_type: "broker_internal", member_ids: [b.id] }));

    await service.sendGroupMessage(a, group.id, "m1");
    await service.sendGroupMessage(a, group.id, "m2");
    expect((await service.unreadCount(b, group.id)).unread).toBe(2); // b hasn't read, and didn't send them
    expect((await service.unreadCount(a, group.id)).unread).toBe(0); // a sent them → not unread for a

    await service.markRead(b, group.id);
    expect((await service.unreadCount(b, group.id)).unread).toBe(0);

    await service.sendGroupMessage(a, group.id, "m3");
    expect((await service.unreadCount(b, group.id)).unread).toBe(1);
  });
});

describe("MessagesService — listing groups, and taking somebody out of one", () => {
  /**
   * The repository's own suite covers what these read and write. What is only
   * decided here is who may ask — and that is the reason the service layer
   * exists over the repository at all.
   */
  it("lists a company's groups only to somebody on that company", async () => {
    const { service } = make();
    const broker = session();
    await service.createGroup(
      broker,
      COMPANY,
      contracts.groupCreate.parse({ name: "Deal Team", group_type: "deal_team" }),
    );

    expect((await service.groupsByCompany(broker, COMPANY)).map((g) => g.name)).toEqual([
      "Deal Team",
    ]);
    await expect(
      service.groupsByCompany(session({ role: "buyer", company_ids: [OTHER] }), COMPANY),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lists a person's own groups without asking which company", async () => {
    // The rail is per-person and spans deals, so there is no company to check
    // against — membership is the check.
    const { service } = make();
    const broker = session();
    const other = session();
    const group = await service.createGroup(
      broker,
      COMPANY,
      contracts.groupCreate.parse({ name: "Deal Team", group_type: "deal_team" }),
    );

    expect((await service.groupsForUser(broker)).map((g) => g.id)).toEqual([group.id]);
    expect(await service.groupsForUser(other)).toEqual([]);
  });

  it("lets a broker take somebody out, and stops the removed person reading on", async () => {
    const { service } = make();
    const broker = session();
    const client = session({ role: "buyer", company_ids: [COMPANY] });
    const group = await service.createGroup(
      broker,
      COMPANY,
      contracts.groupCreate.parse({ name: "Deal Team", group_type: "deal_team" }),
    );
    await service.addMember(broker, group.id, client.id);
    expect(await service.listMembers(broker, group.id)).toContain(client.id);

    await service.removeMember(broker, group.id, client.id);

    expect(await service.listMembers(broker, group.id)).not.toContain(client.id);
    await expect(service.groupMessages(client, group.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a client removing anybody, including themselves", async () => {
    // Membership is the deal team's decision. A client leaving quietly would
    // stop them receiving anything without anyone on the other side knowing.
    const { service } = make();
    const broker = session();
    const client = session({ role: "buyer", company_ids: [COMPANY] });
    const group = await service.createGroup(
      broker,
      COMPANY,
      contracts.groupCreate.parse({ name: "Deal Team", group_type: "deal_team" }),
    );
    await service.addMember(broker, group.id, client.id);

    await expect(service.removeMember(client, group.id, broker.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.removeMember(client, group.id, client.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("MessagesService — the thread rail's order", () => {
  const co = (id: string, name: string, createdAt: string) => ({
    id,
    name,
    industry: null,
    logo: null,
    contactName: null,
    contactEmail: null,
    status: null,
    createdAt,
  });

  it("puts the most recently active deal first", async () => {
    const { repo, service } = make();
    repo.seedThreadCompany(co(COMPANY, "Acme", "2024-01-01T00:00:00.000Z"));
    repo.seedThreadCompany(co(OTHER, "Beta", "2024-01-01T00:00:00.000Z"));

    const user = session({ role: "admin" });
    await service.companySend(user, COMPANY, "older");
    await service.companySend(user, OTHER, "newer");

    expect((await service.threads(user)).map((t) => t.company.id)).toEqual([OTHER, COMPANY]);
  });

  it("falls back to when the deal was created, so an unmessaged one has a place", async () => {
    // Without the fallback a deal nobody has messaged drifts to the bottom in
    // whatever order the query happened to return, and the rail reshuffles
    // between page loads for no reason a reader can see.
    const { repo, service } = make();
    repo.seedThreadCompany(co(COMPANY, "Acme", "2024-01-01T00:00:00.000Z"));
    repo.seedThreadCompany(co(OTHER, "Beta", "2024-06-01T00:00:00.000Z"));

    const user = session({ role: "admin" });
    expect((await service.threads(user)).map((t) => t.company.id)).toEqual([OTHER, COMPANY]);
  });

  it("breaks a tie by name rather than arbitrarily", async () => {
    const { repo, service } = make();
    const same = "2024-01-01T00:00:00.000Z";
    repo.seedThreadCompany(co(OTHER, "Zulu", same));
    repo.seedThreadCompany(co(COMPANY, "Alpha", same));

    const names = (await service.threads(session({ role: "admin" }))).map((t) => t.company.name);
    expect(names).toEqual(["Alpha", "Zulu"]);
  });

  it("answers nothing for a user who can see no deals", async () => {
    const { service } = make();
    expect(await service.threads(session({ role: "buyer", company_ids: [] }))).toEqual([]);
  });
});

describe("MessagesService — who the caller may message", () => {
  const member = (id: string, name: string) => ({ id, name, email: `${name}@x.com`, role: "buyer" });

  it("orders by last activity, then by name, and leaves the caller out", async () => {
    const { repo, service } = make();
    const me = session();
    const spoke = randomUUID();
    const zed = randomUUID();
    const abe = randomUUID();
    repo.seedCompany({ id: COMPANY, name: "Acme" }, [
      member(me.id, "Me"),
      member(zed, "Zed"),
      member(abe, "Abe"),
      member(spoke, "Spoke"),
    ]);
    await service.directSend(me, COMPANY, spoke, "hello");

    const contacts = await service.directContacts(me, COMPANY);
    expect(contacts.contacts.map((c) => c.name)).toEqual(["Spoke", "Abe", "Zed"]);
  });

  it("still lists a contact nobody has spoken to", async () => {
    const { repo, service } = make();
    const me = session();
    const other = randomUUID();
    repo.seedCompany({ id: COMPANY, name: "Acme" }, [member(me.id, "Me"), member(other, "Other")]);

    expect((await service.directContacts(me, COMPANY)).contacts.map((c) => c.id)).toEqual([other]);
  });

  it("skips a company it cannot resolve rather than emptying the whole list", async () => {
    // One bad membership row should not take the contact list away.
    const { repo, service } = make();
    const me = session({ company_ids: [COMPANY, OTHER] });
    repo.seedCompany({ id: COMPANY, name: "Acme" }, [member(me.id, "Me"), member(randomUUID(), "A")]);

    const lists = await service.myDirectContacts(me);
    expect(lists.map((l) => l.company.id)).toEqual([COMPANY]);
  });

  it("answers nothing for a user in no companies at all", async () => {
    const { service } = make();
    expect(await service.myDirectContacts(session({ company_ids: [] }))).toEqual([]);
  });
});

describe("MessagesService — reaching a group", () => {
  const MISSING = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  it("404s a group nobody has, rather than saying access denied", async () => {
    // "Denied" would confirm the group exists to somebody guessing ids.
    const { service } = make();
    const broker = session();
    await expect(service.groupMessages(broker, MISSING)).rejects.toThrow(/not found/i);
    await expect(service.listMembers(broker, MISSING)).rejects.toThrow(/not found/i);
    await expect(service.sendGroupMessage(broker, MISSING, "hello")).rejects.toThrow(/not found/i);
  });

  it("lets a broker on the company read a group they are not in", async () => {
    // A deal team's broker can see the rooms on their own deal without being
    // added to each one; otherwise the person running the deal is the one
    // person who cannot see it.
    const { service } = make();
    const owner = session();
    const group = await service.createGroup(
      owner,
      COMPANY,
      contracts.groupCreate.parse({ name: "Buyer Room", group_type: "deal_team" }),
    );

    const otherBroker = session({ role: "broker", company_ids: [COMPANY] });
    expect(await service.groupMessages(otherBroker, group.id)).toEqual([]);
  });

  it("refuses a broker from a different company", async () => {
    const { service } = make();
    const group = await service.createGroup(
      session(),
      COMPANY,
      contracts.groupCreate.parse({ name: "Buyer Room", group_type: "deal_team" }),
    );
    const outsider = session({ role: "broker", company_ids: [OTHER] });
    await expect(service.groupMessages(outsider, group.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a buyer on the company who is not a member", async () => {
    // Being on the deal is not being in the room.
    const { service } = make();
    const group = await service.createGroup(
      session(),
      COMPANY,
      contracts.groupCreate.parse({ name: "Buyer Room", group_type: "deal_team" }),
    );
    const buyer = session({ role: "buyer", company_ids: [COMPANY] });
    await expect(service.groupMessages(buyer, group.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("MessagesService — auto-created groups", () => {
  it("404s a company that is not there", async () => {
    const { service } = make();
    await expect(service.autoCreateGroups(session(), COMPANY)).rejects.toThrow(/not found/i);
  });

  it("plans against a company with no name rather than failing", async () => {
    // A company row with a null name is not an error the deal team should
    // discover by their rooms failing to appear.
    const { repo, service } = make();
    repo.seedCompany({ id: COMPANY, name: null }, []);
    await expect(service.autoCreateGroups(session(), COMPANY)).resolves.toBeDefined();
  });
});
