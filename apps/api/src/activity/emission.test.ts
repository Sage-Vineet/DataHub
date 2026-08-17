import { randomUUID } from "node:crypto";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { createFoldersRouter } from "../modules/folders/router.js";
import { InMemoryFoldersRepository } from "../modules/folders/repository.memory.js";
import { FoldersService } from "../modules/folders/service.js";
import { createUploadsRouter } from "../modules/uploads/router.js";
import {
  InMemoryDocumentsRepository,
  InMemoryFolderRefPort,
  InMemoryStoragePort,
} from "../modules/uploads/repository.memory.js";
import { UploadsService } from "../modules/uploads/service.js";
import { createActivityCapture } from "./capture.js";
import { InMemoryActivityRepository } from "./repository.memory.js";
import { ActivityWriter } from "./writer.js";

/**
 * Tier-2 emission from the REAL module routers — not a stand-in. The point of
 * these tests is that the emission call sites exist in shipped code and carry the
 * acting user, the subject, and the correlation id that joins them to their
 * envelope. A test against a fake router would prove only that the helper works.
 */

const COMPANY = randomUUID();
const BROKER: SessionUser = {
  id: randomUUID(),
  name: "Broker",
  email: "broker@example.com",
  role: "broker",
  sub_role: "broker_admin",
  company_id: null,
  company_ids: [COMPANY],
};

let repo: InMemoryActivityRepository;
let writer: ActivityWriter;
let folders: InMemoryFoldersRepository;
let app: Express;
let folderId: string;
let uploadId: string;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await writer.flush();
}

beforeEach(async () => {
  repo = new InMemoryActivityRepository();
  writer = new ActivityWriter(repo, { flushIntervalMs: 0 });

  folders = new InMemoryFoldersRepository();
  folderId = randomUUID();
  folders.seed({
    id: folderId,
    companyId: COMPANY,
    parentId: null,
    name: "Key Reports",
    color: null,
    createdBy: BROKER.id,
    archivedAt: null,
    createdAt: new Date(),
  });

  const foldersService = new FoldersService({
    repo: folders,
    fileLink: { assertFolderDeletable: async (): Promise<void> => {} },
    groups: { exists: async (): Promise<boolean> => true },
  });

  const storage = new InMemoryStoragePort();
  const folderRefs = new InMemoryFolderRefPort();
  folderRefs.set(folderId, COMPANY);
  const uploadsService = new UploadsService({
    storage,
    repo: new InMemoryDocumentsRepository(),
    folders: folderRefs,
  });
  const stored = await uploadsService.storeUpload(
    BROKER,
    Buffer.from("balance sheet bytes"),
    "balance-sheet.pdf",
    "application/pdf",
  );
  uploadId = stored.id;

  const requireAuth = (req: Request, _res: Response, next: NextFunction): void => {
    req.user = BROKER;
    next();
  };

  app = express();
  app.use(createActivityCapture({ writer }));
  app.use("/", createFoldersRouter({ service: foldersService, requireAuth }));
  app.use("/", createUploadsRouter({ service: uploadsService, requireAuth }));
});

describe("folders module emits permission events", () => {
  it("records who granted access to whom", async () => {
    const grantee = randomUUID();
    const res = await request(app)
      .post(`/folders/${folderId}/access`)
      .send({ user_id: grantee, permission: "view" });
    expect(res.status).toBe(201);

    await settle();
    const records = await repo.list();
    const event = records.find((r) => r.kind === "event");
    const envelope = records.find((r) => r.kind === "envelope");

    expect(event?.eventType).toBe("access.granted");
    expect(event?.subjectId).toBe(grantee);
    expect(event?.payload).toMatchObject({ folder_id: folderId, granted_by: BROKER.id });
    expect(event?.correlationId).toBe(envelope?.correlationId);
  });

  it("records a revocation", async () => {
    const grantee = randomUUID();
    const created = await request(app)
      .post(`/folders/${folderId}/access`)
      .send({ user_id: grantee, permission: "view" });
    await request(app).delete(`/folder-access/${created.body.id}`).expect(204);

    await settle();
    const events = (await repo.list()).filter((r) => r.kind === "event");
    expect(events.map((e) => e.eventType)).toEqual(["access.granted", "access.revoked"]);
    expect(events[1]?.payload).toMatchObject({ revoked_by: BROKER.id });
  });

  // A denied request must still appear in the log — but as an envelope, not as a
  // success event. The distinction matters: emitting the event before the guard
  // would record grants that never happened.
  it("does not emit a grant event when the request fails", async () => {
    const res = await request(app)
      .post(`/folders/${randomUUID()}/access`)
      .send({ user_id: randomUUID(), permission: "view" });
    expect(res.status).toBeGreaterThanOrEqual(400);

    await settle();
    const records = await repo.list();
    expect(records.filter((r) => r.kind === "event")).toHaveLength(0);
    expect(records.filter((r) => r.kind === "envelope")).toHaveLength(1);
    expect(records[0]?.status).toBe(res.status);
  });
});

describe("uploads module emits document access events", () => {
  it("records a document download against the file", async () => {
    const res = await request(app).get(`/uploads/${uploadId}/content`);
    expect(res.status).toBe(200);

    await settle();
    const event = (await repo.list()).find((r) => r.kind === "event");
    expect(event?.eventType).toBe("document.downloaded");
    expect(event?.subjectId).toBe(uploadId);
    expect(event?.payload).toMatchObject({ file_name: "balance-sheet.pdf" });
  });

  it("records opening a folder's document list", async () => {
    await request(app).get(`/folders/${folderId}/documents`).expect(200);

    await settle();
    const event = (await repo.list()).find((r) => r.kind === "event");
    expect(event?.eventType).toBe("document.opened");
    expect(event?.subjectId).toBe(folderId);
  });

  it("does not record an open for a folder the user cannot reach", async () => {
    const res = await request(app).get(`/folders/${randomUUID()}/documents`);
    expect(res.status).toBeGreaterThanOrEqual(400);

    await settle();
    const records = await repo.list();
    expect(records.filter((r) => r.kind === "event")).toHaveLength(0);
    // The denied attempt is still captured — as an envelope, which is what
    // SE-0004 asks for.
    expect(records.filter((r) => r.kind === "envelope")).toHaveLength(1);
  });

  it("keeps the downloaded bytes out of the log", async () => {
    await request(app).get(`/uploads/${uploadId}/content`);

    await settle();
    expect(JSON.stringify(await repo.list())).not.toContain("balance sheet bytes");
  });
});
