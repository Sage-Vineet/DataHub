import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { CreateRequestInput, RequestsRepository } from "./ports.js";
import { DrizzleRequestsRepository } from "./repository.drizzle.js";
import { InMemoryRequestsRepository } from "./repository.memory.js";

/**
 * One suite, both stores.
 *
 * The rule doing the work is that everything hanging off a request goes when
 * the request does. A reminder pointing at a request that is gone is a row
 * nothing can reach and nothing will ever send; a narrative outliving its
 * request is text nobody can find to correct.
 *
 * The second is that a write against an id nobody has answers null rather than
 * throwing. That is free from a `Map.get` and something a real UPDATE has to be
 * asked about, so asserting it on one store proves nothing about the other.
 */

interface Store {
  repo: RequestsRepository;
  companyId: string;
  userId: string;
  documentId: string;
}

const clients: PGlite[] = [];

const input = (store: Store, over: Partial<CreateRequestInput> = {}): CreateRequestInput => ({
  companyId: store.companyId,
  title: "Send Q1 statements",
  subLabel: null,
  description: "The balance sheet and the P&L.",
  category: "Finance",
  responseType: "Upload",
  priority: "high",
  status: "pending",
  dueDate: "2099-12-31",
  assignedTo: null,
  visible: true,
  reminderFrequencyDays: 1,
  submissionSource: "broker",
  approvalStatus: "approved",
  approvedBy: store.userId,
  approvedAt: new Date("2026-08-01T00:00:00.000Z"),
  createdBy: store.userId,
  ...over,
});

async function drizzleStore(): Promise<Store> {
  const client = await createSchemaDb();
  clients.push(client);
  const db = drizzle(client, { schema }) as unknown as Db;

  const companyId = randomUUID();
  const userId = randomUUID();

  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "tech" });
  await db.insert(schema.users).values({
    id: userId,
    name: "Uma",
    email: `${userId}@x.test`,
    passwordHash: "!",
    role: "broker",
  });
  const [folder] = await db
    .insert(schema.folders)
    .values({ companyId, name: "Financials", createdBy: userId })
    .returning();
  const [document] = await db
    .insert(schema.documents)
    .values({
      companyId,
      folderId: folder!.id,
      name: "Q1.pdf",
      fileUrl: "/uploads/Q1.pdf",
      size: "1",
      ext: "pdf",
      status: "under-review" as never,
      uploadedBy: userId,
    })
    .returning();

  return { repo: new DrizzleRequestsRepository(db), companyId, userId, documentId: document!.id };
}

function memoryStore(): Promise<Store> {
  return Promise.resolve({
    repo: new InMemoryRequestsRepository(),
    companyId: randomUUID(),
    userId: randomUUID(),
    documentId: randomUUID(),
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const STORES: Array<[string, () => Promise<Store>]> = [
  ["Drizzle", drizzleStore],
  ["in memory", memoryStore],
];

describe.each(STORES)("requests (%s)", (_name, open) => {
  it("has nothing to report for a company nobody has asked anything of", async () => {
    const store = await open();
    expect(await store.repo.listByCompany(store.companyId)).toEqual([]);
    expect(await store.repo.getById(randomUUID())).toBeNull();
  });

  it("creates one and reads it back", async () => {
    const store = await open();
    const created = await store.repo.create(input(store));

    expect(await store.repo.getById(created.id)).toMatchObject({
      id: created.id,
      companyId: store.companyId,
      title: "Send Q1 statements",
      priority: "high",
      status: "pending",
      approvalStatus: "approved",
    });
  });

  it("creates several at once, each its own row", async () => {
    // The bulk path is how a template of twenty requests is raised, and it
    // must not collapse them onto one id.
    const store = await open();
    const created = await store.repo.createMany([
      input(store, { title: "First" }),
      input(store, { title: "Second" }),
    ]);

    expect(new Set(created.map((r) => r.id)).size).toBe(2);
    expect((await store.repo.listByCompany(store.companyId)).map((r) => r.title).sort()).toEqual([
      "First",
      "Second",
    ]);
  });

  it("updates only what the patch names", async () => {
    // The detail pane sends the field that changed. Treating an absent field
    // as a clear would wipe the description every time somebody moved a date.
    const store = await open();
    const created = await store.repo.create(input(store));

    const updated = await store.repo.update(created.id, { title: "Send Q1 and Q2" });
    expect(updated).toMatchObject({
      title: "Send Q1 and Q2",
      description: "The balance sheet and the P&L.",
      priority: "high",
    });
  });

  it("records who approved it, and what it was assigned to at the time", async () => {
    const store = await open();
    const created = await store.repo.create(
      input(store, { approvalStatus: "pending", approvedBy: null, approvedAt: null }),
    );

    const approved = await store.repo.approve(created.id, store.userId, store.userId);
    expect(approved).toMatchObject({
      approvalStatus: "approved",
      approvedBy: store.userId,
      assignedTo: store.userId,
    });
  });

  it("leaves the existing assignee alone when the approval names nobody", async () => {
    // Approving is not reassigning. Passing null through would unassign every
    // request the moment it was approved.
    const store = await open();
    const created = await store.repo.create(
      input(store, { assignedTo: store.userId, approvalStatus: "pending", approvedBy: null, approvedAt: null }),
    );

    expect((await store.repo.approve(created.id, store.userId, null))?.assignedTo).toBe(
      store.userId,
    );
  });

  it("answers null for a write against an id nobody has", async () => {
    const store = await open();
    const ghost = randomUUID();

    expect(await store.repo.update(ghost, { title: "x" })).toBeNull();
    expect(await store.repo.approve(ghost, store.userId, null)).toBeNull();
    expect(await store.repo.getNarrative(ghost)).toBeNull();
    expect(await store.repo.listReminders(ghost)).toEqual([]);
    expect(await store.repo.listDocuments(ghost)).toEqual([]);
    await expect(store.repo.delete(ghost)).resolves.toBeUndefined();
  });

  it("keeps one company's requests out of another's", async () => {
    const store = await open();
    await store.repo.create(input(store));
    expect(await store.repo.listByCompany(randomUUID())).toEqual([]);
  });
});

describe.each(STORES)("what hangs off a request (%s)", (_name, open) => {
  const withRequest = (store: Store) => store.repo.create(input(store));

  it("appends reminders and reads them back", async () => {
    const store = await open();
    const request = await withRequest(store);

    await store.repo.appendReminder(request.id, store.userId);
    await store.repo.appendReminder(request.id, store.userId);

    const reminders = await store.repo.listReminders(request.id);
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toMatchObject({ requestId: request.id, sentBy: store.userId });
  });

  it("keeps one narrative per request, replacing rather than appending", async () => {
    // The narrative is the chase note. Two rows for one request means the
    // detail pane shows whichever the query happened to order first.
    const store = await open();
    const request = await withRequest(store);

    await store.repo.upsertNarrative(request.id, "Chased once.", store.userId);
    await store.repo.upsertNarrative(request.id, "Chased twice.", store.userId);

    expect(await store.repo.getNarrative(request.id)).toMatchObject({
      requestId: request.id,
      content: "Chased twice.",
    });
  });

  it("links a document, and says whether the client can see it", async () => {
    const store = await open();
    const request = await withRequest(store);

    await store.repo.linkDocument(request.id, store.documentId, false);
    expect(await store.repo.listDocuments(request.id)).toMatchObject([
      { requestId: request.id, documentId: store.documentId, visible: false },
    ]);
  });

  it("takes the reminders, the narrative and the links with it when deleted", async () => {
    const store = await open();
    const request = await withRequest(store);
    await store.repo.appendReminder(request.id, store.userId);
    await store.repo.upsertNarrative(request.id, "Chased once.", store.userId);
    await store.repo.linkDocument(request.id, store.documentId, true);

    await store.repo.delete(request.id);

    expect(await store.repo.getById(request.id)).toBeNull();
    expect(await store.repo.listReminders(request.id)).toEqual([]);
    expect(await store.repo.getNarrative(request.id)).toBeNull();
    expect(await store.repo.listDocuments(request.id)).toEqual([]);
  });
});
