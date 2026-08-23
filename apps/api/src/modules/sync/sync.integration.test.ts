import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { DrizzleSyncRepository } from "./repository.drizzle.js";
import { createSyncModule } from "./index.js";
import { SyncService } from "./service.js";

/**
 * Sync runs against a real database.
 *
 * Two constraints do the load-bearing work and neither can be checked against
 * a fake: the partial unique index that permits exactly one unfinished run per
 * company and source, and the CHECK that keeps `status` and `finished_at` from
 * drifting apart.
 */

const BROKER: SessionUser = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "B",
  email: "b@x.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [],
};

const SOURCE = "manual_upload_excel_pdf";

let client: PGlite;
let db: Db;
let app: express.Express;
let service: SyncService;
let repo: DrizzleSyncRepository;
let current: SessionUser;
let companyId: string;

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;
  await db.insert(schema.users).values({
    id: BROKER.id,
    name: BROKER.name,
    email: `${BROKER.id}@x.test`,
    passwordHash: "!",
    role: "broker",
  });
  companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });
  current = { ...BROKER, company_ids: [companyId] };

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  const module = createSyncModule({ db, requireAuth });
  app.use("/", module.router);
  service = module.service;
  repo = new DrizzleSyncRepository(db);
});

afterEach(async () => {
  await client.close();
});

const progress = (path = "/manual-report-uploads/sync-progress") =>
  request(app).get(path).set("X-Client-Id", companyId);

describe("what the database enforces", () => {
  it("permits exactly one unfinished run per company and source", async () => {
    await service.start(current, companyId, { sourceKey: SOURCE });
    // The service refuses first with a 409; this proves the index would too, so
    // a race between two requests cannot slip past the check.
    await expect(
      repo.start({
        companyId,
        sourceKey: SOURCE,
        kind: "documents",
        totalFiles: 0,
        startedBy: null,
      }),
    ).rejects.toThrow();
  });

  it("permits a second once the first is finished", async () => {
    const first = await service.start(current, companyId, { sourceKey: SOURCE });
    await service.finish(current, companyId, first.id, { status: "completed" });
    const second = await service.start(current, companyId, { sourceKey: SOURCE });
    expect(second.id).not.toBe(first.id);
  });

  it("permits two different sources at once", async () => {
    await service.start(current, companyId, { sourceKey: SOURCE });
    const other = await service.start(current, companyId, { sourceKey: "quickbooks_online" });
    expect(other.status).toBe("running");
  });

  it("refuses a finished run with no finish time", async () => {
    // `status` and `finished_at` cannot drift apart, so "how long did it take"
    // stays answerable.
    await expect(
      db.insert(schema.syncRuns).values({
        companyId,
        sourceKey: SOURCE,
        status: "completed",
        finishedAt: null,
      }),
    ).rejects.toThrow();
  });

  it("refuses a running run that claims a finish time", async () => {
    await expect(
      db.insert(schema.syncRuns).values({
        companyId,
        sourceKey: SOURCE,
        status: "running",
        finishedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("refuses a status that is not one of the five", async () => {
    await expect(
      db.insert(schema.syncRuns).values({ companyId, sourceKey: SOURCE, status: "paused" }),
    ).rejects.toThrow();
  });
});

describe("progress over HTTP", () => {
  it("answers idle for a company that has never synced", async () => {
    const res = await progress().expect(200);
    expect(res.body.active).toBe(false);
    expect(res.body.currentStep).toBe("idle");
    expect(res.body.percentage).toBe(0);
  });

  it("reports a live run, and survives being asked from anywhere", async () => {
    // The point of the table. Legacy answered from a Map in whichever process
    // started the sync, so a poll landing elsewhere reported idle.
    const run = await service.start(current, companyId, { sourceKey: SOURCE, totalFiles: 4 });
    await service.advance(current, companyId, run.id, {
      processedFiles: 1,
      currentFile: "BS.pdf",
      currentStep: "extracting",
    });

    const res = await progress().expect(200);
    expect(res.body.active).toBe(true);
    expect(res.body.percentage).toBe(25);
    expect(res.body.currentFile).toBe("BS.pdf");
  });

  it("serves the same answer on both legacy paths", async () => {
    // They were separate endpoints over separate Maps; the distinction was in
    // which Map got written, not in what a caller was asking.
    await service.start(current, companyId, { sourceKey: SOURCE, totalFiles: 2 });
    const a = await progress("/manual-report-uploads/sync-progress").expect(200);
    const b = await progress("/manual-upload/sync-progress").expect(200);
    expect(a.body.runId).toBe(b.body.runId);
  });

  it("narrows to a source when asked", async () => {
    await service.start(current, companyId, { sourceKey: "quickbooks_online" });
    const wrong = await request(app)
      .get(`/manual-report-uploads/sync-progress?sourceKey=${SOURCE}`)
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(wrong.body.active).toBe(false);
  });

  it("closes out a run that stopped reporting, and frees the source", async () => {
    const stalled = await service.start(current, companyId, { sourceKey: SOURCE });

    // Reaped by moving the threshold forward rather than waiting five minutes
    // or backdating a column — `reapStalled` takes the cutoff, which is the
    // whole reason it does.
    const closedCount = await repo.reapStalled(companyId, new Date(Date.now() + 60_000));
    expect(closedCount).toBe(1);

    const closed = await repo.getById(companyId, stalled.id);
    expect(closed?.status).toBe("failed");
    expect(closed?.finishedAt).not.toBeNull();

    // And the source is free again.
    const fresh = await service.start(current, companyId, { sourceKey: SOURCE });
    expect(fresh.status).toBe("running");
  });

  it("keeps a history the Maps never had", async () => {
    const first = await service.start(current, companyId, { sourceKey: SOURCE });
    await service.finish(current, companyId, first.id, {
      status: "failed",
      errorMessage: "Could not read page 4.",
      result: { imported: 9 },
    });

    const res = await request(app)
      .get("/manual-report-uploads/sync-history")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].status).toBe("failed");
    expect(res.body.runs[0].errorMessage).toBe("Could not read page 4.");
    expect(res.body.runs[0].result).toEqual({ imported: 9 });
  });

  it("400s without a company and 403s one the caller cannot reach", async () => {
    await request(app).get("/manual-report-uploads/sync-progress").expect(400);
    current = { ...BROKER, company_ids: [] };
    await progress().expect(403);
  });
});
