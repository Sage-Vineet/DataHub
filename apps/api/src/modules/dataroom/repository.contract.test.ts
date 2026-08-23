import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type {
  CommentsRepository,
  DocumentVersionsRepository,
  UploadSessionsRepository,
} from "./ports.js";
import {
  DrizzleCommentsRepository,
  DrizzleDocumentVersionsRepository,
  DrizzleUploadSessionsRepository,
} from "./repository.drizzle.js";
import { DataRoomStore, memoryDataRoom } from "./repository.memory.js";

/**
 * One suite, both stores.
 *
 * Two rules here are the point of the module. Version numbers are allocated by
 * the STORE, not by the service — two concurrent uploads of one file must not
 * be able to agree on a number. And an internal comment is excluded by the
 * QUERY rather than filtered after: the same mistake already exists once in
 * this codebase (folder grants stored server-side and honoured only in the
 * browser) and is not repeated here.
 */

interface Store {
  versions: DocumentVersionsRepository;
  comments: CommentsRepository;
  sessions: UploadSessionsRepository;
  companyId: string;
  folderId: string;
  documentId: string;
  userId: string;
  /** A real blob, because `upload_sessions.upload_id` is a foreign key. */
  storeBlob(fileName: string): Promise<string>;
}

const clients: PGlite[] = [];

async function drizzleStore(): Promise<Store> {
  const client = await createSchemaDb();
  clients.push(client);
  const db = drizzle(client, { schema }) as unknown as Db;

  const companyId = randomUUID();
  const userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    name: "Uma",
    email: `${userId}@x.test`,
    passwordHash: "!",
    role: "broker",
  });
  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });
  const [folder] = await db
    .insert(schema.folders)
    .values({ companyId, name: "Financials", createdBy: userId })
    .returning();
  const [document] = await db
    .insert(schema.documents)
    .values({
      companyId,
      folderId: folder!.id,
      name: "Accounts.pdf",
      fileUrl: "/uploads/Accounts.pdf",
      size: "1",
      ext: "pdf",
      status: "under-review" as never,
      uploadedBy: userId,
    })
    .returning();

  return {
    versions: new DrizzleDocumentVersionsRepository(db),
    comments: new DrizzleCommentsRepository(db),
    sessions: new DrizzleUploadSessionsRepository(db),
    companyId,
    folderId: folder!.id,
    documentId: document!.id,
    userId,
    storeBlob: async (fileName: string) => {
      const [upload] = await db
        .insert(schema.uploads)
        .values({
          fileName,
          contentType: "application/pdf",
          sizeBytes: 10,
          data: Buffer.from("helloworld"),
          uploadedBy: userId,
        })
        .returning();
      return upload!.id;
    },
  };
}

function memoryStore(): Promise<Store> {
  const store = new DataRoomStore();
  const ports = memoryDataRoom(store);
  const companyId = randomUUID();
  const folderId = randomUUID();
  const documentId = randomUUID();
  const userId = randomUUID();

  store.seedFolder(folderId, companyId);
  store.seedDocument({ id: documentId, companyId, folderId, name: "Accounts.pdf" });
  store.seedUserName(userId, "Uma");

  return Promise.resolve({
    versions: ports.versions,
    comments: ports.comments,
    sessions: ports.sessions,
    companyId,
    folderId,
    documentId,
    userId,
    storeBlob: () => Promise.resolve(randomUUID()),
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const STORES: Array<[string, () => Promise<Store>]> = [
  ["Drizzle", drizzleStore],
  ["in memory", memoryStore],
];

describe.each(STORES)("document versions (%s)", (_name, open) => {
  const append = (store: Store, over: Record<string, unknown> = {}) =>
    store.versions.append({
      documentId: store.documentId,
      uploadId: null,
      fileName: "Accounts.pdf",
      sizeBytes: 1024,
      contentType: "application/pdf",
      note: null,
      createdBy: store.userId,
      ...over,
    });

  it("has nothing to report for a document nobody has re-uploaded", async () => {
    const store = await open();
    expect(await store.versions.listFor(store.documentId)).toEqual([]);
    expect(await store.versions.getById(randomUUID())).toBeNull();
  });

  it("allocates the version number itself, from one", async () => {
    // Allocation belongs to the store rather than the service: two concurrent
    // uploads of one file must not be able to agree on a number.
    const store = await open();
    expect((await append(store)).versionNo).toBe(1);
    expect((await append(store)).versionNo).toBe(2);
  });

  it("repoints the document at the version it just appended", async () => {
    const store = await open();
    await append(store);
    const second = await append(store);

    expect(await store.versions.currentFor(store.documentId)).toEqual({
      currentVersionId: second.id,
      versionCount: 2,
    });
  });

  it("keeps every version readable, newest first", async () => {
    // History is append-only, so what a reader saw at any past moment stays
    // reconstructable.
    const store = await open();
    const first = await append(store, { note: "original" });
    const second = await append(store, { note: "corrected" });

    const all = await store.versions.listFor(store.documentId);
    expect(all.map((v) => v.id)).toEqual([second.id, first.id]);
    expect(all.find((v) => v.id === first.id)?.note).toBe("original");
  });

  it("finds a document in a folder by name, which is how a re-upload becomes a version", async () => {
    const store = await open();
    expect((await store.versions.findDocumentByName(store.folderId, "Accounts.pdf"))?.id).toBe(
      store.documentId,
    );
    expect(await store.versions.findDocumentByName(store.folderId, "Other.pdf")).toBeNull();
    expect(await store.versions.findDocumentByName(randomUUID(), "Accounts.pdf")).toBeNull();
  });

  it("reports no current version for a document nobody has re-uploaded", async () => {
    // `version_count` defaults to 1 — a stored document IS its first version,
    // and the version rows only start appearing when it is re-uploaded. There
    // is no CURRENT version id until one does.
    const store = await open();
    expect(await store.versions.currentFor(store.documentId)).toEqual({
      currentVersionId: null,
      versionCount: 1,
    });
  });
});

describe.each(STORES)("comments (%s)", (_name, open) => {
  const comment = (store: Store, over: Record<string, unknown> = {}) =>
    store.comments.create({
      documentId: store.documentId,
      companyId: store.companyId,
      versionId: null,
      parentId: null,
      body: "Where does this figure come from?",
      visibility: "shared",
      pageNumber: null,
      authorId: store.userId,
      ...over,
    });

  it("has nothing to report on a document nobody has commented on", async () => {
    const store = await open();
    expect(await store.comments.listFor(store.documentId, true)).toEqual([]);
    expect(await store.comments.getById(randomUUID())).toBeNull();
  });

  it("stores a comment and reads it back with its author's name", async () => {
    const store = await open();
    const created = await comment(store);
    expect(created).toMatchObject({ body: "Where does this figure come from?", visibility: "shared" });
    expect((await store.comments.getById(created.id))?.authorName).toBe("Uma");
  });

  it("leaves an internal comment out of the QUERY, not out of the answer", async () => {
    // An internal comment must be ABSENT for a counterparty, not present and
    // hidden by the caller. The same mistake exists once in this codebase —
    // folder grants stored server-side and honoured only in the browser — and
    // is not repeated here.
    const store = await open();
    const shared = await comment(store);
    const internal = await comment(store, { visibility: "internal", body: "Ask them about this." });

    const all = await store.comments.listFor(store.documentId, true);
    expect(all.map((c) => c.id).sort()).toEqual([shared.id, internal.id].sort());

    const external = await store.comments.listFor(store.documentId, false);
    expect(external.map((c) => c.id)).toEqual([shared.id]);
  });

  it("keeps a reply against the comment it answers", async () => {
    const store = await open();
    const parent = await comment(store);
    const reply = await comment(store, { parentId: parent.id, body: "From the trial balance." });
    expect(reply.parentId).toBe(parent.id);
  });

  it("takes a comment off the document without taking the others", async () => {
    const store = await open();
    const kept = await comment(store);
    const removed = await comment(store, { body: "Never mind." });

    await store.comments.softDelete(removed.id);
    expect((await store.comments.listFor(store.documentId, true)).map((c) => c.id)).toEqual([
      kept.id,
    ]);
  });

  it("records the page a comment was left on, when there is one", async () => {
    const store = await open();
    const created = await comment(store, { pageNumber: 7 });
    expect(created.pageNumber).toBe(7);
  });
});

describe.each(STORES)("upload sessions (%s)", (_name, open) => {
  const start = (store: Store, over: Record<string, unknown> = {}) =>
    store.sessions.create({
      companyId: store.companyId,
      folderId: store.folderId,
      documentId: null,
      fileName: "Big.pdf",
      contentType: "application/pdf",
      totalBytes: 10,
      chunkSize: 5,
      totalChunks: 2,
      createdBy: store.userId,
      ...over,
    });

  it("answers null for a session nobody has", async () => {
    const store = await open();
    expect(await store.sessions.getById(randomUUID())).toBeNull();
  });

  it("opens a session with nothing received yet", async () => {
    const store = await open();
    const session = await start(store);
    expect(session).toMatchObject({ status: "open", totalChunks: 2 });
    expect(await store.sessions.receivedIndices(session.id)).toEqual([]);
  });

  it("reports which chunks arrived, in order, so a client can resume", async () => {
    const store = await open();
    const session = await start(store);
    await store.sessions.putChunk(session.id, 1, Buffer.from("world"));
    await store.sessions.putChunk(session.id, 0, Buffer.from("hello"));

    expect(await store.sessions.receivedIndices(session.id)).toEqual([0, 1]);
  });

  it("replaces a re-sent chunk rather than duplicating it", async () => {
    // A client that retries a chunk it already sent must not double the file.
    const store = await open();
    const session = await start(store);
    await store.sessions.putChunk(session.id, 0, Buffer.from("first"));
    await store.sessions.putChunk(session.id, 0, Buffer.from("again"));

    expect(await store.sessions.receivedIndices(session.id)).toEqual([0]);
  });

  it("closes a completed session against the blob it produced", async () => {
    const store = await open();
    const session = await start(store);
    await store.sessions.putChunk(session.id, 0, Buffer.from("hello"));
    await store.sessions.putChunk(session.id, 1, Buffer.from("world"));
    const uploadId = await store.storeBlob("Big.pdf");
    await store.sessions.markCompleted(session.id, uploadId);

    const after = await store.sessions.getById(session.id);
    expect(after?.status).toBe("completed");
    expect(after?.uploadId).toBe(uploadId);
  });

  it("closes an abandoned one as aborted", async () => {
    const store = await open();
    const session = await start(store);
    await store.sessions.abort(session.id);
    expect((await store.sessions.getById(session.id))?.status).toBe("aborted");
  });

  it("sweeps expired sessions without touching a live one", async () => {
    // Called opportunistically on creation rather than on a schedule: there is
    // no scheduler anywhere in this repository.
    const store = await open();
    const live = await start(store);
    expect(await store.sessions.sweepExpired()).toBeGreaterThanOrEqual(0);
    expect((await store.sessions.getById(live.id))?.status).toBe("open");
  });
});
