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
    const bytes = Buffer.from("hello world", "utf8");
    const up = await service.storeUpload(session(), bytes, "note.txt", "text/plain");
    expect(up.size_bytes).toBe(bytes.length);

    const blob = await service.getUploadContent(up.id);
    expect(blob.bytes.equals(bytes)).toBe(true);
    expect(blob.contentType).toBe("text/plain");
  });

  it("404s an unknown upload", async () => {
    const { service } = make();
    await expect(service.getUploadContent(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
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
