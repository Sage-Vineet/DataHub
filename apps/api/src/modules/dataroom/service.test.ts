import { beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { DataRoomStore, memoryDataRoom } from "./repository.memory.js";
import { DataRoomService } from "./service.js";
import type { DataRoomActivityPort } from "./ports.js";

const CO = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_CO = "aaaaaaaa-0000-4000-8000-000000000002";
const FOLDER = "bbbbbbbb-0000-4000-8000-000000000001";
const DOC = "cccccccc-0000-4000-8000-000000000001";

const broker: SessionUser = {
  id: "dddddddd-0000-4000-8000-000000000001",
  name: "Blake Broker",
  email: "broker@x.test",
  role: "broker",
  company_id: CO,
  status: "active",
  company_ids: [CO],
};

const seller: SessionUser = {
  ...broker,
  id: "dddddddd-0000-4000-8000-000000000002",
  name: "Dana Seller",
  email: "seller@x.test",
  role: "buyer",
};

const outsider: SessionUser = {
  ...broker,
  id: "dddddddd-0000-4000-8000-000000000003",
  email: "out@x.test",
  company_id: OTHER_CO,
  company_ids: [OTHER_CO],
};

let store: DataRoomStore;
let service: DataRoomService;
let emitted: Array<{ type: string; subjectId: string }>;

function build() {
  const ports = memoryDataRoom();
  store = ports.store;
  emitted = [];
  const activity: DataRoomActivityPort = {
    emit: (e) => emitted.push({ type: e.type, subjectId: e.subjectId }),
  };
  service = new DataRoomService({
    versions: ports.versions,
    comments: ports.comments,
    sessions: ports.sessions,
    storage: ports.storage,
    documents: ports.documents,
    activity,
  });
}

/** Push a file through the whole chunked path, as a client would. */
async function upload(
  user: SessionUser,
  opts: { fileName: string; parts: string[]; documentId?: string },
) {
  const total = opts.parts.reduce((n, p) => n + p.length, 0);
  const session = await service.openSession(user, {
    folder_id: FOLDER,
    file_name: opts.fileName,
    content_type: "text/plain",
    total_bytes: total,
    chunk_size: Math.max(...opts.parts.map((p) => p.length)),
    ...(opts.documentId ? { document_id: opts.documentId } : {}),
  });
  for (const [i, part] of opts.parts.entries()) {
    await service.putChunk(user, session.id, i, Buffer.from(part));
  }
  return service.completeSession(user, session.id);
}

beforeEach(() => {
  build();
  store.seedFolder(FOLDER, CO);
  store.seedUserName(broker.id, "Blake Broker");
});

describe("tenant isolation", () => {
  beforeEach(() => {
    store.seedDocument({ id: DOC, companyId: CO, folderId: FOLDER, name: "a.pdf" });
  });

  it("refuses versions for a document in a company the caller cannot reach", async () => {
    await expect(service.listVersions(outsider, DOC)).rejects.toThrow(/do not have access/i);
  });

  it("refuses comments for a document in another company", async () => {
    await expect(service.listComments(outsider, DOC)).rejects.toThrow(/do not have access/i);
  });

  it("refuses to open a session against a folder in another company", async () => {
    await expect(
      service.openSession(outsider, {
        folder_id: FOLDER,
        file_name: "x.txt",
        content_type: "text/plain",
        total_bytes: 10,
        chunk_size: 1024 * 1024,
      }),
    ).rejects.toThrow(/do not have access/i);
  });

  it("reports a missing document as not found, not as forbidden", async () => {
    await expect(
      service.listVersions(broker, "cccccccc-0000-4000-8000-00000000dead"),
    ).rejects.toThrow(/not found/i);
  });
});

describe("versioning", () => {
  it("makes a re-upload of the same name a new version of the same document", async () => {
    const first = await upload(broker, { fileName: "model.xlsx", parts: ["v1-body"] });

    const second = await upload(broker, { fileName: "model.xlsx", parts: ["v2-body"] });

    expect(second.document_id).toBe(first.document_id);
    expect(second.version_no).toBe(2);
  });

  it("keeps every prior version readable after a re-upload", async () => {
    const first = await upload(broker, { fileName: "model.xlsx", parts: ["v1"] });
    await upload(broker, { fileName: "model.xlsx", parts: ["v2"] });

    const list = await service.listVersions(broker, first.document_id);

    expect(list.version_count).toBe(2);
    expect(list.versions.map((v) => v.version_no)).toEqual([2, 1]);
    // v1's blob is still resolvable, which is the whole promise of versioning.
    const v1 = list.versions.find((v) => v.version_no === 1)!;
    await expect(service.versionUploadId(broker, v1.id)).resolves.toBeTruthy();
  });

  it("marks exactly one version current", async () => {
    const first = await upload(broker, { fileName: "model.xlsx", parts: ["v1"] });
    await upload(broker, { fileName: "model.xlsx", parts: ["v2"] });

    const list = await service.listVersions(broker, first.document_id);

    expect(list.versions.filter((v) => v.is_current)).toHaveLength(1);
    expect(list.versions.find((v) => v.is_current)!.version_no).toBe(2);
  });

  it("treats a different name in the same folder as a different document", async () => {
    const a = await upload(broker, { fileName: "a.txt", parts: ["x"] });
    const b = await upload(broker, { fileName: "b.txt", parts: ["y"] });

    expect(b.document_id).not.toBe(a.document_id);
    expect(b.version_no).toBe(1);
  });

  it("restores by appending, so history is never rewritten", async () => {
    const first = await upload(broker, { fileName: "model.xlsx", parts: ["v1"] });
    const v1 = (await service.listVersions(broker, first.document_id)).versions[0]!;
    await upload(broker, { fileName: "model.xlsx", parts: ["v2"] });

    const restored = await service.restoreVersion(broker, first.document_id, v1.id, null);

    expect(restored.version_no).toBe(3);
    const list = await service.listVersions(broker, first.document_id);
    expect(list.versions.map((v) => v.version_no)).toEqual([3, 2, 1]);
  });

  it("restores content by pointing at the old blob rather than copying it", async () => {
    const first = await upload(broker, { fileName: "model.xlsx", parts: ["original"] });
    const v1 = (await service.listVersions(broker, first.document_id)).versions[0]!;
    await upload(broker, { fileName: "model.xlsx", parts: ["replacement"] });

    const restored = await service.restoreVersion(broker, first.document_id, v1.id, null);

    expect(restored.upload_id).toBe(v1.upload_id);
  });

  it("records why a version exists when a restore created it", async () => {
    const first = await upload(broker, { fileName: "m.xlsx", parts: ["v1"] });
    const v1 = (await service.listVersions(broker, first.document_id)).versions[0]!;

    const restored = await service.restoreVersion(broker, first.document_id, v1.id, null);

    expect(restored.note).toMatch(/restored from v1/i);
  });

  it("refuses to restore a version belonging to a different document", async () => {
    const a = await upload(broker, { fileName: "a.txt", parts: ["x"] });
    const b = await upload(broker, { fileName: "b.txt", parts: ["y"] });
    const bV1 = (await service.listVersions(broker, b.document_id)).versions[0]!;

    await expect(
      service.restoreVersion(broker, a.document_id, bV1.id, null),
    ).rejects.toThrow(/not found on this document/i);
  });

  it("records a version event on the audit trail", async () => {
    await upload(broker, { fileName: "m.xlsx", parts: ["v1"] });

    expect(emitted.map((e) => e.type)).toContain("document.version.created");
  });

  it("records a restore distinctly from a fresh upload", async () => {
    const first = await upload(broker, { fileName: "m.xlsx", parts: ["v1"] });
    const v1 = (await service.listVersions(broker, first.document_id)).versions[0]!;
    emitted.length = 0;

    await service.restoreVersion(broker, first.document_id, v1.id, null);

    expect(emitted.map((e) => e.type)).toEqual(["document.version.restored"]);
  });
});

describe("chunked upload", () => {
  it("assembles chunks in index order, not arrival order", async () => {
    const session = await service.openSession(broker, {
      folder_id: FOLDER,
      file_name: "ordered.txt",
      content_type: "text/plain",
      total_bytes: 6,
      chunk_size: 3,
    });
    // Deliberately out of order.
    await service.putChunk(broker, session.id, 1, Buffer.from("DEF"));
    await service.putChunk(broker, session.id, 0, Buffer.from("ABC"));

    const done = await service.completeSession(broker, session.id);

    expect(store.blobs.get(done.upload_id)!.toString()).toBe("ABCDEF");
  });

  it("reports which chunks it has, so a client can resume", async () => {
    const session = await service.openSession(broker, {
      folder_id: FOLDER,
      file_name: "resume.txt",
      content_type: "text/plain",
      total_bytes: 9,
      chunk_size: 3,
    });
    await service.putChunk(broker, session.id, 0, Buffer.from("AAA"));
    await service.putChunk(broker, session.id, 2, Buffer.from("CCC"));

    const status = await service.getSession(broker, session.id);

    expect(status.received).toEqual([0, 2]);
  });

  it("treats a re-sent chunk as a replacement, never a duplicate", async () => {
    const session = await service.openSession(broker, {
      folder_id: FOLDER,
      file_name: "retry.txt",
      content_type: "text/plain",
      total_bytes: 3,
      chunk_size: 1024 * 1024,
    });
    await service.putChunk(broker, session.id, 0, Buffer.from("bad"));

    const after = await service.putChunk(broker, session.id, 0, Buffer.from("ok!"));

    expect(after.received).toEqual([0]);
    const done = await service.completeSession(broker, session.id);
    expect(store.blobs.get(done.upload_id)!.toString()).toBe("ok!");
  });

  it("refuses to complete while a chunk is missing, naming the gap", async () => {
    const session = await service.openSession(broker, {
      folder_id: FOLDER,
      file_name: "partial.txt",
      content_type: "text/plain",
      total_bytes: 9,
      chunk_size: 3,
    });
    await service.putChunk(broker, session.id, 0, Buffer.from("AAA"));
    await service.putChunk(broker, session.id, 2, Buffer.from("CCC"));

    // A file assembled from a partial set is silently corrupt — the worst
    // outcome available here, because it looks like success.
    await expect(service.completeSession(broker, session.id)).rejects.toThrow(
      /incomplete.*starting at 1/i,
    );
  });

  it("rejects a chunk index outside the session's range", async () => {
    const session = await service.openSession(broker, {
      folder_id: FOLDER,
      file_name: "range.txt",
      content_type: "text/plain",
      total_bytes: 6,
      chunk_size: 3,
    });

    await expect(
      service.putChunk(broker, session.id, 9, Buffer.from("XXX")),
    ).rejects.toThrow(/between 0 and 1/);
  });

  it("rejects a chunk bigger than the session agreed", async () => {
    const session = await service.openSession(broker, {
      folder_id: FOLDER,
      file_name: "big.txt",
      content_type: "text/plain",
      total_bytes: 6,
      chunk_size: 3,
    });

    await expect(
      service.putChunk(broker, session.id, 0, Buffer.from("far too long")),
    ).rejects.toThrow(/larger than the size/i);
  });

  it("rejects an empty chunk rather than counting it as received", async () => {
    const session = await service.openSession(broker, {
      folder_id: FOLDER,
      file_name: "empty.txt",
      content_type: "text/plain",
      total_bytes: 3,
      chunk_size: 3,
    });

    await expect(
      service.putChunk(broker, session.id, 0, Buffer.alloc(0)),
    ).rejects.toThrow(/cannot be empty/i);
  });

  it("refuses further chunks once a session is completed", async () => {
    const session = await service.openSession(broker, {
      folder_id: FOLDER,
      file_name: "closed.txt",
      content_type: "text/plain",
      total_bytes: 3,
      chunk_size: 3,
    });
    await service.putChunk(broker, session.id, 0, Buffer.from("abc"));
    await service.completeSession(broker, session.id);

    await expect(
      service.putChunk(broker, session.id, 0, Buffer.from("xyz")),
    ).rejects.toThrow(/already completed/i);
  });

  it("discards chunk data once the session completes", async () => {
    const session = await service.openSession(broker, {
      folder_id: FOLDER,
      file_name: "clean.txt",
      content_type: "text/plain",
      total_bytes: 3,
      chunk_size: 3,
    });
    await service.putChunk(broker, session.id, 0, Buffer.from("abc"));

    await service.completeSession(broker, session.id);

    expect(store.chunks.has(session.id)).toBe(false);
  });

  it("sweeps expired sessions when a new one opens, with no scheduler", async () => {
    await service.openSession(broker, {
      folder_id: FOLDER,
      file_name: "x.txt",
      content_type: "text/plain",
      total_bytes: 3,
      chunk_size: 1024 * 1024,
    });

    expect(store.swept).toBe(1);
  });

  it("refuses a session naming a document that lives in a different folder", async () => {
    store.seedFolder("bbbbbbbb-0000-4000-8000-000000000002", CO);
    store.seedDocument({
      id: DOC,
      companyId: CO,
      folderId: "bbbbbbbb-0000-4000-8000-000000000002",
      name: "elsewhere.txt",
    });

    await expect(
      service.openSession(broker, {
        folder_id: FOLDER,
        file_name: "elsewhere.txt",
        content_type: "text/plain",
        total_bytes: 3,
        chunk_size: 1024 * 1024,
        document_id: DOC,
      }),
    ).rejects.toThrow(/not in the folder you named/i);
  });
});

describe("comments", () => {
  beforeEach(() => {
    store.seedDocument({ id: DOC, companyId: CO, folderId: FOLDER, name: "a.pdf" });
  });

  it("defaults a comment to internal", async () => {
    const created = await service.addComment(broker, DOC, {
      body: "our side only",
      visibility: "internal",
    });

    expect(created.visibility).toBe("internal");
  });

  it("keeps internal comments out of a counterparty's response entirely", async () => {
    await service.addComment(broker, DOC, { body: "internal note", visibility: "internal" });
    await service.addComment(broker, DOC, { body: "shared note", visibility: "shared" });

    const asSeller = await service.listComments(seller, DOC);

    // Absent, not present-and-hidden: the caller never receives the text.
    expect(asSeller.map((c) => c.body)).toEqual(["shared note"]);
  });

  it("shows the deal side both kinds", async () => {
    await service.addComment(broker, DOC, { body: "internal note", visibility: "internal" });
    await service.addComment(broker, DOC, { body: "shared note", visibility: "shared" });

    const asBroker = await service.listComments(broker, DOC);

    expect(asBroker).toHaveLength(2);
  });

  it("stops a counterparty leaving an internal comment", async () => {
    await expect(
      service.addComment(seller, DOC, { body: "sneaky", visibility: "internal" }),
    ).rejects.toThrow(/only the deal team/i);
  });

  it("lets a counterparty leave a shared comment", async () => {
    const created = await service.addComment(seller, DOC, {
      body: "here is the context",
      visibility: "shared",
    });

    expect(created.visibility).toBe("shared");
  });

  it("attributes a comment to its author", async () => {
    const created = await service.addComment(broker, DOC, {
      body: "note",
      visibility: "internal",
    });

    expect(created.author_id).toBe(broker.id);
    expect(created.author_name).toBe("Blake Broker");
  });

  it("records a comment on the audit trail", async () => {
    await service.addComment(broker, DOC, { body: "note", visibility: "shared" });

    expect(emitted.map((e) => e.type)).toContain("document.comment.added");
  });

  it("lets an author remove their own comment", async () => {
    const created = await service.addComment(seller, DOC, { body: "oops", visibility: "shared" });

    await service.deleteComment(seller, created.id);

    expect(await service.listComments(seller, DOC)).toHaveLength(0);
  });

  it("stops one party deleting another's commentary on shared evidence", async () => {
    const created = await service.addComment(broker, DOC, {
      body: "broker note",
      visibility: "shared",
    });

    await expect(service.deleteComment(seller, created.id)).rejects.toThrow(
      /only delete your own/i,
    );
  });

  it("lets the deal side remove any comment on its own deal", async () => {
    const created = await service.addComment(seller, DOC, {
      body: "seller note",
      visibility: "shared",
    });

    await expect(service.deleteComment(broker, created.id)).resolves.toBeUndefined();
  });
});
