import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { ItemsRepository, ResponsesRepository } from "./ports.js";
import { DrizzleItemsRepository, DrizzleResponsesRepository } from "./repository.drizzle.js";
import { memoryQa, QaStore } from "./repository.memory.js";

/**
 * One suite, both stores.
 *
 * Two rules here are not conveniences. A posted response is IMMUTABLE
 * (`QA - 0002`) — the port has no update and no delete, so a correction is a
 * new response superseding the old one, and the old one stays readable. And a
 * per-item visibility override decides who can see a question at all, so a
 * fake that answered it differently from the database would let a test prove
 * an isolation property the product does not have.
 */

interface Store {
  items: ItemsRepository;
  responses: ResponsesRepository;
  companyId: string;
  asker: string;
  answerer: string;
}

const clients: PGlite[] = [];

async function drizzleStore(): Promise<Store> {
  const client = await createSchemaDb();
  clients.push(client);
  const db = drizzle(client, { schema }) as unknown as Db;

  const companyId = randomUUID();
  const asker = randomUUID();
  const answerer = randomUUID();
  await db.insert(schema.users).values([
    { id: asker, name: "Asker", email: `${asker}@x.test`, passwordHash: "!", role: "broker" },
    { id: answerer, name: "Answerer", email: `${answerer}@x.test`, passwordHash: "!", role: "buyer" },
  ]);
  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });

  return {
    items: new DrizzleItemsRepository(db),
    responses: new DrizzleResponsesRepository(db),
    companyId,
    asker,
    answerer,
  };
}

function memoryStore(): Promise<Store> {
  const store = new QaStore();
  const ports = memoryQa(store);
  const companyId = randomUUID();
  const asker = randomUUID();
  const answerer = randomUUID();
  store.addMember(companyId, asker, "Asker");
  store.addMember(companyId, answerer, "Answerer");

  return Promise.resolve({
    items: ports.items,
    responses: ports.responses,
    companyId,
    asker,
    answerer,
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const STORES: Array<[string, () => Promise<Store>]> = [
  ["Drizzle", drizzleStore],
  ["in memory", memoryStore],
];

describe.each(STORES)("questions (%s)", (_name, open) => {
  const ask = (store: Store, over: Record<string, unknown> = {}) =>
    store.items.create({
      companyId: store.companyId,
      categoryId: null,
      title: "Explain the Q3 swing",
      body: "Revenue moved 18% — why?",
      priority: "medium",
      origin: "manual",
      moduleTag: "qa",
      sectionTag: null,
      accountRef: null,
      externalRef: null,
      dueDate: null,
      requestorId: store.asker,
      createdBy: store.asker,
      reference: "QA-001",
      ...over,
    });

  const viewer = (store: Store) => ({ userId: store.asker, roleKey: "broker" });

  it("has nothing to report for a company nobody has asked about", async () => {
    const store = await open();
    expect(await store.items.list(store.companyId, { viewer: viewer(store) })).toEqual([]);
    expect(await store.items.getById(randomUUID())).toBeNull();
  });

  it("stores a question and reads it back", async () => {
    const store = await open();
    const item = await ask(store);
    expect(item).toMatchObject({
      companyId: store.companyId,
      title: "Explain the Q3 swing",
      priority: "medium",
      status: "open",
      reference: "QA-001",
    });
    expect((await store.items.getById(item.id))?.id).toBe(item.id);
  });

  it("numbers references per company", async () => {
    const store = await open();
    expect(await store.items.nextReference(store.companyId)).toMatch(/^QA-/);
    await ask(store);
    const second = await store.items.nextReference(store.companyId);
    expect(second).toMatch(/^QA-/);
  });

  it("narrows a listing by status and by who raised it", async () => {
    const store = await open();
    const mine = await ask(store);
    await ask(store, { requestorId: store.answerer, createdBy: store.answerer, reference: "QA-002" });

    const asRequestor = await store.items.list(store.companyId, {
      viewer: viewer(store),
      mine: { userId: store.asker, as: "requestor" },
    });
    expect(asRequestor.map((i) => i.id)).toEqual([mine.id]);

    await store.items.update(mine.id, { status: "closed" });
    const open_ = await store.items.list(store.companyId, { viewer: viewer(store), status: "open" });
    expect(open_.map((i) => i.id)).not.toContain(mine.id);
  });

  it("answers null for updating a question nobody has", async () => {
    const store = await open();
    expect(await store.items.update(randomUUID(), { title: "x" })).toBeNull();
  });

  it("marks a question answered once, and does not restamp it", async () => {
    // The stamp is when the FIRST answer landed. Moving it on every later
    // response makes "time to first answer" measure the last one.
    const store = await open();
    const item = await ask(store);
    await store.items.markAnswered(item.id, new Date("2026-01-01T00:00:00.000Z"));
    const first = (await store.items.getById(item.id))?.answeredAt;

    await store.items.markAnswered(item.id, new Date("2026-06-01T00:00:00.000Z"));
    expect((await store.items.getById(item.id))?.answeredAt).toBe(first);
  });

  it("shrugs off marking a question nobody has", async () => {
    const store = await open();
    await expect(store.items.markAnswered(randomUUID(), new Date())).resolves.toBeUndefined();
  });

  it("hides a question from the user an override names", async () => {
    // A per-item override decides who can see a question at all. A fake that
    // answered this differently from the database would let a test prove an
    // isolation property the product does not have.
    const store = await open();
    const item = await ask(store);
    expect(await store.items.isHiddenFrom(item.id, store.answerer, "buyer")).toBe(false);

    await store.items.setVisibilityRule({
      itemId: item.id,
      userId: store.answerer,
      roleKey: null,
      effect: "hide",
      createdBy: store.asker,
    });

    expect(await store.items.isHiddenFrom(item.id, store.answerer, "buyer")).toBe(true);
    expect(await store.items.isHiddenFrom(item.id, store.asker, "broker")).toBe(false);
  });

  it("hides a question from a whole role", async () => {
    const store = await open();
    const item = await ask(store);
    await store.items.setVisibilityRule({
      itemId: item.id,
      userId: null,
      roleKey: "buyer",
      effect: "hide",
      createdBy: store.asker,
    });

    expect(await store.items.isHiddenFrom(item.id, store.answerer, "buyer")).toBe(true);
    expect(await store.items.isHiddenFrom(item.id, store.asker, "broker")).toBe(false);
  });

  it("leaves a hidden question out of the listing entirely", async () => {
    const store = await open();
    const item = await ask(store);
    await store.items.setVisibilityRule({
      itemId: item.id,
      userId: store.answerer,
      roleKey: null,
      effect: "hide",
      createdBy: store.asker,
    });

    const asAnswerer = await store.items.list(store.companyId, {
      viewer: { userId: store.answerer, roleKey: "buyer" },
    });
    expect(asAnswerer.map((i) => i.id)).not.toContain(item.id);
  });
});

describe.each(STORES)("responses, which cannot be edited (%s)", (_name, open) => {
  const ask = (store: Store) =>
    store.items.create({
      companyId: store.companyId,
      categoryId: null,
      title: "Explain the Q3 swing",
      body: "Revenue moved 18% — why?",
      priority: "medium",
      origin: "manual",
      moduleTag: "qa",
      sectionTag: null,
      accountRef: null,
      externalRef: null,
      dueDate: null,
      requestorId: store.asker,
      createdBy: store.asker,
      reference: "QA-001",
    });

  it("has nothing to report for a question nobody answered", async () => {
    const store = await open();
    const item = await ask(store);
    expect(await store.responses.listFor(item.id)).toEqual([]);
    expect(await store.responses.getById(randomUUID())).toBeNull();
  });

  it("appends an answer and reads it back", async () => {
    const store = await open();
    const item = await ask(store);
    const ref = await store.responses.nextCitationRef(item.id, "QA-001");
    const answer = await store.responses.append({
      itemId: item.id,
      body: "A one-off contract.",
      kind: "answer",
      authorId: store.answerer,
      supersedesId: null,
      citationRef: ref,
    });

    expect(answer).toMatchObject({ kind: "answer", isCurrent: true, answerVersion: 1 });
    expect((await store.responses.listFor(item.id)).map((r) => r.id)).toEqual([answer.id]);
  });

  it("supersedes rather than replacing, and keeps the superseded one readable", async () => {
    // `QA - 0002`: a posted response is permanently immutable. A correction is
    // a new response pointing at the old one, and a reader can still see what
    // was said before it.
    const store = await open();
    const item = await ask(store);
    const first = await store.responses.append({
      itemId: item.id,
      body: "A one-off contract.",
      kind: "answer",
      authorId: store.answerer,
      supersedesId: null,
      citationRef: await store.responses.nextCitationRef(item.id, "QA-001"),
    });
    const second = await store.responses.append({
      itemId: item.id,
      body: "Two contracts, not one.",
      kind: "answer",
      authorId: store.answerer,
      supersedesId: first.id,
      citationRef: await store.responses.nextCitationRef(item.id, "QA-001"),
    });

    const all = await store.responses.listFor(item.id);
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === first.id)?.body).toBe("A one-off contract.");
    expect(second.supersedesId).toBe(first.id);
    expect(second.answerVersion).toBe(2);
    expect(second.isCurrent).toBe(true);
    expect(all.find((r) => r.id === first.id)?.isCurrent).toBe(false);
  });

  it("roots every version of an answer at the first one", async () => {
    // So "the answer and its history" is one query rather than a walk back up
    // a chain of supersedes.
    const store = await open();
    const item = await ask(store);
    const first = await store.responses.append({
      itemId: item.id,
      body: "One",
      kind: "answer",
      authorId: store.answerer,
      supersedesId: null,
      citationRef: await store.responses.nextCitationRef(item.id, "QA-001"),
    });
    const second = await store.responses.append({
      itemId: item.id,
      body: "Two",
      kind: "answer",
      authorId: store.answerer,
      supersedesId: first.id,
      citationRef: await store.responses.nextCitationRef(item.id, "QA-001"),
    });

    expect(first.answerRootId).toBe(first.id);
    expect(second.answerRootId).toBe(first.id);
  });

  it("gives a comment no answer root, because it is not one", async () => {
    const store = await open();
    const item = await ask(store);
    const comment = await store.responses.append({
      itemId: item.id,
      body: "Chasing this one.",
      kind: "comment",
      authorId: store.asker,
      supersedesId: null,
      citationRef: await store.responses.nextCitationRef(item.id, "QA-001"),
    });
    expect(comment.answerRootId).toBeNull();
  });

  it("never collides two citation references on one question", async () => {
    const store = await open();
    const item = await ask(store);
    const refs = [
      await store.responses.nextCitationRef(item.id, "QA-001"),
      await store.responses.nextCitationRef(item.id, "QA-001"),
    ];
    // The second only differs once the first has actually been used.
    await store.responses.append({
      itemId: item.id,
      body: "One",
      kind: "answer",
      authorId: store.answerer,
      supersedesId: null,
      citationRef: refs[0]!,
    });
    const after = await store.responses.nextCitationRef(item.id, "QA-001");
    expect(after).not.toBe(refs[0]);
  });
});
