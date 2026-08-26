import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { MessagesRepository } from "./ports.js";
import { DrizzleMessagesRepository } from "./repository.drizzle.js";
import { InMemoryMessagesRepository } from "./repository.memory.js";

/**
 * One suite, both stores.
 *
 * The rule doing the work is that a direct conversation is SYMMETRIC: A→B and
 * B→A are one thread, read the same way from either end. Get that wrong and
 * each party sees half the conversation and neither can tell.
 */

interface Store {
  repo: MessagesRepository;
  companyId: string;
  otherCompanyId: string;
  alice: string;
  bob: string;
}

const clients: PGlite[] = [];

async function drizzleStore(): Promise<Store> {
  const client = await createSchemaDb();
  clients.push(client);
  const db = drizzle(client, { schema }) as unknown as Db;

  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();

  await db.insert(schema.users).values([
    { id: alice, name: "Alice", email: `${alice}@x.test`, passwordHash: "!", role: "broker" },
    { id: bob, name: "Bob", email: `${bob}@x.test`, passwordHash: "!", role: "buyer" },
  ]);
  await db.insert(schema.companies).values([
    { id: companyId, name: "Acme", industry: "" },
    { id: otherCompanyId, name: "Beta", industry: "" },
  ]);
  await db.insert(schema.userCompanies).values([
    { userId: alice, companyId },
    { userId: bob, companyId },
  ]);

  return { repo: new DrizzleMessagesRepository(db), companyId, otherCompanyId, alice, bob };
}

function memoryStore(): Promise<Store> {
  const repo = new InMemoryMessagesRepository();
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();

  repo.seedCompany({ id: companyId, name: "Acme" }, [
    { id: alice, name: "Alice", email: "alice@x.test", role: "broker" },
    { id: bob, name: "Bob", email: "bob@x.test", role: "buyer" },
  ]);
  repo.seedCompany({ id: otherCompanyId, name: "Beta" }, []);

  return Promise.resolve({ repo, companyId, otherCompanyId, alice, bob });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const STORES: Array<[string, () => Promise<Store>]> = [
  ["Drizzle", drizzleStore],
  ["in memory", memoryStore],
];

describe.each(STORES)("messages (%s)", (_name, open) => {
  it("has nothing to report on a deal nobody has spoken on", async () => {
    const store = await open();
    expect(await store.repo.listCompany(store.companyId)).toEqual([]);
    expect(await store.repo.listDirect(store.companyId, store.alice, store.bob)).toEqual([]);
    expect(await store.repo.listGroupsByCompany(store.companyId)).toEqual([]);
  });

  it("keeps a company conversation in the order it was said", async () => {
    const store = await open();
    await store.repo.sendCompany(store.companyId, store.alice, "first");
    await store.repo.sendCompany(store.companyId, store.bob, "second");

    expect((await store.repo.listCompany(store.companyId)).map((m) => m.body)).toEqual([
      "first",
      "second",
    ]);
  });

  it("reads a direct conversation the same way from either end", async () => {
    // One thread, not two. Read asymmetrically each party sees half of it and
    // neither has any way to tell.
    const store = await open();
    await store.repo.sendDirect(store.companyId, store.alice, store.bob, "hi Bob");
    await store.repo.sendDirect(store.companyId, store.bob, store.alice, "hi Alice");

    const asAlice = await store.repo.listDirect(store.companyId, store.alice, store.bob);
    const asBob = await store.repo.listDirect(store.companyId, store.bob, store.alice);
    expect(asAlice.map((m) => m.body)).toEqual(["hi Bob", "hi Alice"]);
    expect(asBob.map((m) => m.body)).toEqual(asAlice.map((m) => m.body));
  });

  it("keeps a direct message out of the company conversation", async () => {
    // They share a table. A direct message surfacing on the deal thread is a
    // private exchange shown to everyone on it.
    const store = await open();
    await store.repo.sendDirect(store.companyId, store.alice, store.bob, "just between us");
    expect(await store.repo.listCompany(store.companyId)).toEqual([]);
  });

  it("keeps one deal's conversation out of another's", async () => {
    const store = await open();
    await store.repo.sendCompany(store.companyId, store.alice, "ours");
    expect(await store.repo.listCompany(store.otherCompanyId)).toEqual([]);
  });

  it("reports the most recent message per company", async () => {
    const store = await open();
    await store.repo.sendCompany(store.companyId, store.alice, "older");
    await store.repo.sendCompany(store.companyId, store.bob, "newer");

    const latest = await store.repo.latestCompanyMessages([
      store.companyId,
      store.otherCompanyId,
    ]);
    expect(latest.get(store.companyId)?.body).toBe("newer");
    expect(latest.get(store.otherCompanyId)).toBeUndefined();
  });

  it("reports the most recent direct message per contact, either way round", async () => {
    const store = await open();
    await store.repo.sendDirect(store.companyId, store.alice, store.bob, "from Alice");
    await store.repo.sendDirect(store.companyId, store.bob, store.alice, "from Bob");

    const latest = await store.repo.latestDirectByContact(store.companyId, store.alice, [
      store.bob,
    ]);
    expect(latest.get(store.bob)?.body).toBe("from Bob");
  });

  it("asks about nobody without touching the store", async () => {
    const store = await open();
    expect((await store.repo.latestDirectByContact(store.companyId, store.alice, [])).size).toBe(0);
    expect((await store.repo.latestCompanyMessages([])).size).toBe(0);
  });

  it("lists the deal's members", async () => {
    const store = await open();
    const ids = (await store.repo.listCompanyMembers(store.companyId)).map((m) => m.id).sort();
    expect(ids).toEqual([store.alice, store.bob].sort());
  });

  it("answers null for a company nobody has", async () => {
    const store = await open();
    expect(await store.repo.getCompany(randomUUID())).toBeNull();
    expect(await store.repo.listCompanyMembers(randomUUID())).toEqual([]);
  });
});

describe.each(STORES)("groups (%s)", (_name, open) => {
  const group = (store: Store, name = "Deal Team") =>
    store.repo.createGroup({
      companyId: store.companyId,
      name,
      groupType: "deal_team",
      buyerUserId: null,
      autoCreated: false,
      memberIds: [],
    });

  it("creates a group and finds it again", async () => {
    const store = await open();
    const created = await group(store);
    expect(await store.repo.getGroup(created.id)).toMatchObject({ id: created.id, name: "Deal Team" });
    expect((await store.repo.listGroupsByCompany(store.companyId)).map((g) => g.id)).toEqual([
      created.id,
    ]);
  });

  it("answers null for a group nobody has", async () => {
    const store = await open();
    expect(await store.repo.getGroup(randomUUID())).toBeNull();
    expect(await store.repo.listMembers(randomUUID())).toEqual([]);
    expect(await store.repo.isMember(randomUUID(), store.alice)).toBe(false);
  });

  it("adds a member once, however often it is asked", async () => {
    // The pair is the primary key, so a repeated add is the same membership.
    const store = await open();
    const created = await group(store);
    await store.repo.addMember(created.id, store.bob);
    await store.repo.addMember(created.id, store.bob);

    expect(await store.repo.listMembers(created.id)).toEqual([store.bob]);
    expect(await store.repo.isMember(created.id, store.bob)).toBe(true);
  });

  it("removes a member without touching the others", async () => {
    const store = await open();
    const created = await group(store);
    await store.repo.addMember(created.id, store.alice);
    await store.repo.addMember(created.id, store.bob);
    await store.repo.removeMember(created.id, store.bob);

    expect(await store.repo.listMembers(created.id)).toEqual([store.alice]);
  });

  it("renames in place, because auto-creation re-runs when a firm name changes", async () => {
    const store = await open();
    const created = await group(store);
    await store.repo.renameGroup(created.id, "Renamed");
    expect((await store.repo.getGroup(created.id))?.name).toBe("Renamed");
  });

  it("counts what a member has not read, and nothing once they have", async () => {
    // The badge. Counting a member's own messages would make it impossible to
    // clear by reading.
    const store = await open();
    const created = await group(store);
    await store.repo.addMember(created.id, store.alice);
    await store.repo.addMember(created.id, store.bob);
    await store.repo.sendGroupMessage(created.id, store.alice, "one");
    await store.repo.sendGroupMessage(created.id, store.alice, "two");

    expect(await store.repo.unreadCount(created.id, store.bob)).toBe(2);
    await store.repo.markRead(created.id, store.bob);
    expect(await store.repo.unreadCount(created.id, store.bob)).toBe(0);
  });

  it("lists a group's messages in the order they were said", async () => {
    const store = await open();
    const created = await group(store);
    await store.repo.sendGroupMessage(created.id, store.alice, "first");
    await store.repo.sendGroupMessage(created.id, store.bob, "second");

    expect((await store.repo.listGroupMessages(created.id)).map((m) => m.body)).toEqual([
      "first",
      "second",
    ]);
  });

  it("lists the groups a user belongs to, and none for a stranger", async () => {
    const store = await open();
    const created = await group(store);
    await store.repo.addMember(created.id, store.bob);

    expect((await store.repo.listGroupsForUser(store.bob)).map((g) => g.id)).toEqual([created.id]);
    expect(await store.repo.listGroupsForUser(randomUUID())).toEqual([]);
  });
});
