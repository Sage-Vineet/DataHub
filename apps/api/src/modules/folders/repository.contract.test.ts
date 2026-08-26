import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { FoldersRepository } from "./ports.js";
import { DrizzleFoldersRepository } from "./repository.drizzle.js";
import { InMemoryFoldersRepository } from "./repository.memory.js";

/**
 * One suite, both stores.
 *
 * Two rules carry the weight here.
 *
 * The first is that (company, parent, name) is UNIQUE, and that provisioning
 * is therefore idempotent: `ensureDefaultFolders` runs on every login for a
 * client user, and a second run must find the hierarchy rather than build a
 * second copy of it beside the first. Two "Financials" folders in one data
 * room is not a cosmetic problem — documents go into one of them and the other
 * looks empty.
 *
 * The second is that an id nobody has answers `null` rather than throwing. The
 * service checks access before writing, so these are reached when a folder is
 * deleted between a page loading and a button being pressed — and the two
 * stores have to agree, because an in-memory `Map.get` returns undefined for
 * free while a real UPDATE has to be asked what it affected.
 */

interface Store {
  repo: FoldersRepository;
  companyId: string;
  otherCompanyId: string;
  userId: string;
}

const clients: PGlite[] = [];

async function drizzleStore(): Promise<Store> {
  const client = await createSchemaDb();
  clients.push(client);
  const db = drizzle(client, { schema }) as unknown as Db;

  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const userId = randomUUID();

  await db.insert(schema.companies).values([
    { id: companyId, name: "Acme", industry: "tech" },
    { id: otherCompanyId, name: "Beta", industry: "tech" },
  ]);
  await db.insert(schema.users).values({
    id: userId,
    name: "Uma",
    email: `${userId}@x.test`,
    passwordHash: "!",
    role: "broker",
  });

  return { repo: new DrizzleFoldersRepository(db), companyId, otherCompanyId, userId };
}

function memoryStore(): Promise<Store> {
  return Promise.resolve({
    repo: new InMemoryFoldersRepository(),
    companyId: randomUUID(),
    otherCompanyId: randomUUID(),
    userId: randomUUID(),
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const STORES: Array<[string, () => Promise<Store>]> = [
  ["Drizzle", drizzleStore],
  ["in memory", memoryStore],
];

describe.each(STORES)("folders (%s)", (_name, open) => {
  const newFolder = (store: Store, name = "Financials", parentId: string | null = null) =>
    store.repo.create({
      companyId: store.companyId,
      parentId,
      name,
      color: null,
      createdBy: store.userId,
    });

  it("has nothing to report for a company with no data room yet", async () => {
    const store = await open();
    expect(await store.repo.listByCompany(store.companyId, false)).toEqual([]);
    expect(await store.repo.countByCompany(store.companyId)).toBe(0);
    expect(await store.repo.getById(randomUUID())).toBeNull();
  });

  it("creates a folder and reads it back by id", async () => {
    const store = await open();
    const created = await newFolder(store);
    expect(await store.repo.getById(created.id)).toMatchObject({
      id: created.id,
      companyId: store.companyId,
      name: "Financials",
      parentId: null,
      archivedAt: null,
    });
  });

  it("answers the existing folder rather than a duplicate", async () => {
    // The uniqueness index, and what makes provisioning idempotent. Two
    // "Financials" folders in one data room is not cosmetic: documents go into
    // one and the other looks empty.
    const store = await open();
    const first = await newFolder(store);
    const second = await newFolder(store);

    expect(second.id).toBe(first.id);
    expect(await store.repo.countByCompany(store.companyId)).toBe(1);
  });

  it("treats the same name under a different parent as a different folder", async () => {
    // "2023/Statements" and "2024/Statements" are both ordinary.
    const store = await open();
    const y2023 = await newFolder(store, "2023");
    const y2024 = await newFolder(store, "2024");

    const a = await newFolder(store, "Statements", y2023.id);
    const b = await newFolder(store, "Statements", y2024.id);

    expect(b.id).not.toBe(a.id);
    expect(await store.repo.countByCompany(store.companyId)).toBe(4);
  });

  it("keeps one company's folders out of another's", async () => {
    const store = await open();
    await newFolder(store);
    expect(await store.repo.listByCompany(store.otherCompanyId, true)).toEqual([]);
    expect(await store.repo.countByCompany(store.otherCompanyId)).toBe(0);
  });

  it("renames and recolours without moving anything", async () => {
    const store = await open();
    const created = await newFolder(store);
    const updated = await store.repo.update(created.id, { name: "Financial Statements", color: "#0af" });

    expect(updated).toMatchObject({ name: "Financial Statements", color: "#0af" });
    expect(updated?.parentId).toBeNull();
  });

  it("moves a folder under a parent, and back to the root", async () => {
    const store = await open();
    const parent = await newFolder(store, "2024");
    const child = await newFolder(store, "Statements");

    expect((await store.repo.move(child.id, parent.id))?.parentId).toBe(parent.id);
    expect((await store.repo.move(child.id, null))?.parentId).toBeNull();
  });

  it("hides an archived folder from the default listing and keeps it on request", async () => {
    // Archiving is what a broker does at the end of a deal. The folder still
    // has to be findable, or the documents in it are gone as far as anyone can
    // tell.
    const store = await open();
    const created = await newFolder(store);

    const archived = await store.repo.setArchived(created.id, true);
    expect(archived?.archivedAt).not.toBeNull();
    expect(await store.repo.listByCompany(store.companyId, false)).toEqual([]);
    expect((await store.repo.listByCompany(store.companyId, true)).map((f) => f.id)).toEqual([
      created.id,
    ]);

    const restored = await store.repo.setArchived(created.id, false);
    expect(restored?.archivedAt).toBeNull();
    expect(await store.repo.listByCompany(store.companyId, false)).toHaveLength(1);
  });

  it("answers null for a write against an id nobody has", async () => {
    const store = await open();
    const ghost = randomUUID();

    expect(await store.repo.update(ghost, { name: "x" })).toBeNull();
    expect(await store.repo.move(ghost, null)).toBeNull();
    expect(await store.repo.setArchived(ghost, true)).toBeNull();
    expect(await store.repo.getAccessById(ghost)).toBeNull();
    expect(await store.repo.updateAccess(ghost, { canRead: false })).toBeNull();
  });

  it("deletes a folder, and an id nobody has is not an error", async () => {
    const store = await open();
    const created = await newFolder(store);

    await store.repo.delete(created.id);
    expect(await store.repo.getById(created.id)).toBeNull();
    await expect(store.repo.delete(randomUUID())).resolves.toBeUndefined();
  });
});

describe.each(STORES)("who may open a folder (%s)", (_name, open) => {
  const withFolder = async (store: Store) =>
    store.repo.create({
      companyId: store.companyId,
      parentId: null,
      name: "Financials",
      color: null,
      createdBy: store.userId,
    });

  it("has no grants on a folder nobody has shared", async () => {
    const store = await open();
    const folder = await withFolder(store);
    expect(await store.repo.listAccess(folder.id)).toEqual([]);
  });

  it("records a grant and reads it back", async () => {
    const store = await open();
    const folder = await withFolder(store);
    const grant = await store.repo.createAccess({
      folderId: folder.id,
      userId: store.userId,
      groupId: null,
      canRead: true,
      canWrite: false,
      canDownload: false,
      createdBy: store.userId,
    });

    expect(await store.repo.getAccessById(grant.id)).toMatchObject({
      folderId: folder.id,
      userId: store.userId,
      canRead: true,
      canWrite: false,
      canDownload: false,
    });
    expect((await store.repo.listAccess(folder.id)).map((a) => a.id)).toEqual([grant.id]);
  });

  it("changes one permission without disturbing the others", async () => {
    // The page sends only what the toggle changed. Treating an absent field as
    // false would silently revoke download every time somebody granted write.
    const store = await open();
    const folder = await withFolder(store);
    const grant = await store.repo.createAccess({
      folderId: folder.id,
      userId: store.userId,
      groupId: null,
      canRead: true,
      canWrite: false,
      canDownload: true,
      createdBy: store.userId,
    });

    const updated = await store.repo.updateAccess(grant.id, { canWrite: true });
    expect(updated).toMatchObject({ canRead: true, canWrite: true, canDownload: true });
  });

  it("takes a grant back", async () => {
    const store = await open();
    const folder = await withFolder(store);
    const grant = await store.repo.createAccess({
      folderId: folder.id,
      userId: store.userId,
      groupId: null,
      canRead: true,
      canWrite: false,
      canDownload: false,
      createdBy: store.userId,
    });

    await store.repo.deleteAccess(grant.id);
    expect(await store.repo.getAccessById(grant.id)).toBeNull();
    expect(await store.repo.listAccess(folder.id)).toEqual([]);
  });

  it("takes a deleted folder's grants with it", async () => {
    // Design D5: the FK cascades. A grant outliving its folder would be a row
    // nothing can revoke through the UI, because the UI reaches grants through
    // the folder.
    const store = await open();
    const folder = await withFolder(store);
    await store.repo.createAccess({
      folderId: folder.id,
      userId: store.userId,
      groupId: null,
      canRead: true,
      canWrite: false,
      canDownload: false,
      createdBy: store.userId,
    });

    await store.repo.delete(folder.id);
    expect(await store.repo.listAccess(folder.id)).toEqual([]);
  });
});
