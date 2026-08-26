import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import {
  InMemoryDocumentsRepository,
  InMemoryFolderRefPort,
  InMemoryStoragePort,
} from "./repository.memory.js";
import { UploadsService } from "./service.js";

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const FOLDER = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function make() {
  const storage = new InMemoryStoragePort();
  const repo = new InMemoryDocumentsRepository();
  const folders = new InMemoryFolderRefPort();
  folders.set(FOLDER, COMPANY);
  return { storage, repo, folders, service: new UploadsService({ storage, repo, folders }) };
}

const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(),
  name: "U",
  email: "u@example.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
  ...over,
});

async function addDoc(service: UploadsService, user: SessionUser, uploadId: string) {
  return service.addDocument(user, FOLDER, {
    name: "Q1.pdf",
    upload_id: uploadId,
    size: "2048",
    ext: "pdf",
  });
}

describe("UploadsService — blob round-trip", () => {
  it("stores bytes and streams them back with the content type", async () => {
    const { service } = make();
    const user = session();
    const bytes = Buffer.from("hello world", "utf8");
    const up = await service.storeUpload(user, bytes, "note.txt", "text/plain");
    expect(up.size_bytes).toBe(bytes.length);
    await addDoc(service, user, up.id);

    const blob = await service.getUploadContent(user, up.id);
    expect(blob.bytes.equals(bytes)).toBe(true);
    expect(blob.contentType).toBe("text/plain");
  });

  it("404s an unknown upload", async () => {
    const { service } = make();
    await expect(service.getUploadContent(session(), randomUUID())).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  /**
   * The regression that motivated authorizing this route.
   *
   * Every sibling route resolves folder grants, but the one that actually serves
   * bytes took no caller at all — so a signed-in user of another tenant who knew
   * (or guessed) an upload id got the file. Reproduced live against the demo
   * stack before the fix: a broker who was correctly 403'd on the company still
   * read that company's document through `/uploads/:id/content`.
   */
  it("denies a caller who cannot reach the document holding the blob", async () => {
    const { service } = make();
    const owner = session();
    const up = await service.storeUpload(owner, Buffer.from("secret", "utf8"), "s.txt", "text/plain");
    await addDoc(service, owner, up.id);

    const outsider = session({ company_ids: [OTHER] });
    await expect(service.getUploadContent(outsider, up.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  /** A blob nothing references is unreachable, and 404 does not confirm the id. */
  it("404s a blob that no document references", async () => {
    const { service } = make();
    const user = session();
    const up = await service.storeUpload(user, Buffer.from("orphan", "utf8"), "o.txt", "text/plain");
    await expect(service.getUploadContent(user, up.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("UploadsService — documents under a folder", () => {
  it("adds, lists, archives (filtered) and deletes with tenant guard", async () => {
    const { service } = make();
    const user = session();
    const up = await service.storeUpload(user, Buffer.from("x"), "a.pdf", "application/pdf");
    const doc = await addDoc(service, user, up.id);
    expect(doc.folder_id).toBe(FOLDER);
    expect(doc.company_id).toBe(COMPANY);
    expect(doc.upload_id).toBe(up.id);

    expect((await service.listDocuments(user, FOLDER, false)).map((d) => d.id)).toEqual([doc.id]);

    await service.archiveDocument(user, doc.id);
    expect(await service.listDocuments(user, FOLDER, false)).toEqual([]);
    expect((await service.listDocuments(user, FOLDER, true)).length).toBe(1);

    await service.deleteDocument(user, doc.id);
    expect(await service.listDocuments(user, FOLDER, true)).toEqual([]);
  });

  it("denies a user who cannot access the folder's company", async () => {
    const { service } = make();
    const outsider = session({ role: "buyer", company_ids: [OTHER] });
    await expect(
      service.addDocument(outsider, FOLDER, { name: "x", upload_id: randomUUID(), size: "1", ext: "pdf" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.listDocuments(outsider, FOLDER, false)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("brings an archived document back", async () => {
    // Archiving is reversible on purpose — it is what a broker does at the end
    // of a deal, and a one-way door there means a mis-click loses a document
    // from every listing with no way back short of re-uploading it.
    const { service } = make();
    const user = session();
    const up = await service.storeUpload(user, Buffer.from("x"), "a.pdf", "application/pdf");
    const doc = await addDoc(service, user, up.id);

    await service.archiveDocument(user, doc.id);
    expect(await service.listDocuments(user, FOLDER, false)).toEqual([]);

    const restored = await service.unarchiveDocument(user, doc.id);
    expect(restored.id).toBe(doc.id);
    expect((await service.listDocuments(user, FOLDER, false)).map((d) => d.id)).toEqual([doc.id]);
  });

  it("refuses a document addressed directly from another company", async () => {
    /**
     * The folder check is not enough on its own. A document is addressed by
     * its OWN id here, so somebody holding one from another deal reaches this
     * without ever naming a folder — which is why the company is checked on
     * the document before the folder is consulted at all.
     */
    const { service } = make();
    const user = session();
    const up = await service.storeUpload(user, Buffer.from("x"), "a.pdf", "application/pdf");
    const doc = await addDoc(service, user, up.id);

    const outsider = session({ role: "buyer", company_ids: [OTHER] });
    await expect(service.archiveDocument(outsider, doc.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.unarchiveDocument(outsider, doc.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.deleteDocument(outsider, doc.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("404s documents/folders that don't exist", async () => {
    const { service } = make();
    await expect(service.listDocuments(session(), randomUUID(), false)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.deleteDocument(session(), randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("UploadsService — activity", () => {
  it("records and lists activity, and delete cascades it", async () => {
    const { service } = make();
    const user = session();
    const up = await service.storeUpload(user, Buffer.from("x"), "a.pdf", "application/pdf");
    const doc = await addDoc(service, user, up.id);

    await service.recordActivity(user, doc.id, "downloaded");
    await service.recordActivity(user, doc.id, "viewed");
    const log = await service.listActivity(user, doc.id);
    expect(log.map((a) => a.action)).toEqual(["downloaded", "viewed"]);
    expect(log[0]!.actor_id).toBe(user.id);

    await service.deleteDocument(user, doc.id);
    await expect(service.listActivity(user, doc.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
