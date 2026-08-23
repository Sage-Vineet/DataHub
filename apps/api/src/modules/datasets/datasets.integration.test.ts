import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { DrizzleDatasetsRepository } from "./repository.drizzle.js";
import { createDatasetsModule } from "./index.js";
import { DatasetsService } from "./service.js";

/**
 * Dataset versions against a real database.
 *
 * Three constraints carry the weight and none can be checked against a fake:
 * the per-company version numbering, the partial unique index permitting one
 * active version, and the CHECK forbidding an active version that is not
 * finalized — which is what stops every report being pointed at half-written
 * data.
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

let client: PGlite;
let db: Db;
let app: express.Express;
let service: DatasetsService;
let repo: DrizzleDatasetsRepository;
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
  const module = createDatasetsModule({ db, requireAuth });
  app.use("/", module.router);
  service = module.service;
  repo = new DrizzleDatasetsRepository(db);
});

afterEach(async () => {
  await client.close();
});

/** Create a version and take it all the way to finalized. */
async function finalized(over: { sourceKey?: string; rowCount?: number } = {}) {
  const created = await repo.create({
    companyId,
    sourceKey: over.sourceKey ?? "manual_gl_upload",
    label: null,
    syncRunId: null,
    createdBy: BROKER.id,
  });
  return (await repo.finalize(created.id, {
    rowCount: over.rowCount ?? 100,
    fiscalYears: [2023, 2024],
  }))!;
}

const list = () =>
  request(app).get("/manual-gl/dataset-versions").set("X-Client-Id", companyId);

describe("numbering", () => {
  it("numbers per company and source, from one", async () => {
    const first = await finalized();
    const second = await finalized();
    expect([first.versionNumber, second.versionNumber]).toEqual([1, 2]);
  });

  it("keeps separate sequences per source", async () => {
    // A QuickBooks pull and a spreadsheet import have nothing to do with each
    // other and should not share a numbering they cannot both control.
    await finalized();
    const other = await finalized({ sourceKey: "quickbooks_online" });
    expect(other.versionNumber).toBe(1);
  });

  it("refuses a duplicate number outright", async () => {
    await finalized();
    await expect(
      db.insert(schema.datasetVersions).values({
        companyId,
        sourceKey: "manual_gl_upload",
        versionNumber: 1,
      }),
    ).rejects.toThrow();
  });
});

describe("what the database will not allow", () => {
  it("refuses an active version that is not finalized", async () => {
    // The one that matters: activating something still staging points every
    // report at data that is not finished being written.
    const staging = await repo.create({
      companyId,
      sourceKey: "manual_gl_upload",
      label: null,
      syncRunId: null,
      createdBy: null,
    });
    expect(staging.status).toBe("staging");
    await expect(
      db
        .update(schema.datasetVersions)
        .set({ isActive: true })
        .where(eq(schema.datasetVersions.id, staging.id)),
    ).rejects.toThrow();
  });

  it("refuses a status outside the five", async () => {
    await expect(
      db.insert(schema.datasetVersions).values({
        companyId,
        sourceKey: "manual_gl_upload",
        versionNumber: 99,
        status: "archived",
      }),
    ).rejects.toThrow();
  });

  it("permits only one active version per company", async () => {
    const a = await finalized();
    const b = await finalized();
    await service.activate(current, companyId, a.id);

    expect(b.isActive).toBe(false);
    // `a` is already active; forcing `b` active too must hit the index.
    await expect(
      db
        .update(schema.datasetVersions)
        .set({ isActive: true })
        .where(eq(schema.datasetVersions.id, b.id)),
    ).rejects.toThrow();
  });
});

describe("activating", () => {
  it("stands the previous one down as rolled_back", async () => {
    // "This was current and was replaced" is a different fact from "this was
    // never activated", and the list is unreadable without the distinction.
    const first = await finalized();
    const second = await finalized();
    await service.activate(current, companyId, first.id);
    await service.activate(current, companyId, second.id);

    const versions = await service.list(current, companyId);
    const one = versions.find((v) => v.id === first.id)!;
    const two = versions.find((v) => v.id === second.id)!;
    expect(one.status).toBe("rolled_back");
    expect(one.isActive).toBe(false);
    expect(two.isActive).toBe(true);
  });

  it("is a no-op on the one already active", async () => {
    const only = await finalized();
    await service.activate(current, companyId, only.id);
    const again = await service.activate(current, companyId, only.id);
    expect(again.isActive).toBe(true);
  });

  it("refuses one that is still staging, saying why", async () => {
    const staging = await repo.create({
      companyId,
      sourceKey: "manual_gl_upload",
      label: null,
      syncRunId: null,
      createdBy: null,
    });
    const res = await request(app)
      .post(`/manual-gl/dataset-versions/${staging.id}/activate`)
      .set("X-Client-Id", companyId)
      .expect(400);
    expect(res.body.error).toContain("staging");
  });

  it("404s one that is not there", async () => {
    await request(app)
      .post(`/manual-gl/dataset-versions/${randomUUID()}/activate`)
      .set("X-Client-Id", companyId)
      .expect(404);
  });
});

describe("rolling back", () => {
  it("returns to an earlier version and makes it usable again", async () => {
    const first = await finalized();
    const second = await finalized();
    await service.activate(current, companyId, first.id);
    await service.activate(current, companyId, second.id);

    const back = await service.rollback(current, companyId, first.id);
    expect(back.isActive).toBe(true);
    // Not left marked rolled_back — it is current again, and saying otherwise
    // would be a contradiction on the face of the row.
    expect(back.status).toBe("finalized");
  });

  it("refuses to roll FORWARD under that name", async () => {
    const first = await finalized();
    const second = await finalized();
    await service.activate(current, companyId, first.id);

    const res = await request(app)
      .post(`/manual-gl/dataset-versions/${second.id}/rollback`)
      .set("X-Client-Id", companyId)
      .expect(400);
    expect(res.body.error).toContain("newer");
  });

  it("refuses a version that failed part-way", async () => {
    // It was abandoned half-written; pointing the reports at it would show
    // figures nobody ever signed off.
    const broken = await repo.create({
      companyId,
      sourceKey: "manual_gl_upload",
      label: null,
      syncRunId: null,
      createdBy: null,
    });
    await repo.fail(broken.id, "The file stopped part-way through.");

    const res = await request(app)
      .post(`/manual-gl/dataset-versions/${broken.id}/rollback`)
      .set("X-Client-Id", companyId)
      .expect(400);
    expect(res.body.error).toContain("failed");
  });
});

describe("the list the SPA reads", () => {
  it("answers a bare array, newest first", async () => {
    // The store does `versions.find(...)` on the response, so an envelope
    // alone would give it an object with no `.find`.
    await finalized();
    const second = await finalized();
    const res = await list().expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe(second.id);
  });

  it("carries the version number under every name the SPA reaches for", async () => {
    // `version.value ?? version.dataset_version ?? version.version_number`.
    const only = await finalized();
    await service.activate(current, companyId, only.id);
    const [row] = (await list().expect(200)).body;

    expect(row.value).toBe(1);
    expect(row.versionNumber).toBe(1);
    expect(row.is_active).toBe(true);
    expect(row.isActive).toBe(true);
  });

  it("reports what is in each version without a table scan", async () => {
    const only = await finalized({ rowCount: 3723 });
    const [row] = (await list().expect(200)).body;
    expect(row.rowCount).toBe(3723);
    expect(row.fiscalYears).toEqual([2023, 2024]);
    expect(only.rowCount).toBe(3723);
  });

  it("403s a company the caller cannot reach, and 400s with none", async () => {
    current = { ...BROKER, company_ids: [] };
    await list().expect(403);
    await request(app).get("/manual-gl/dataset-versions").expect(400);
  });
});

describe("upload jobs, served from sync runs", () => {
  it("lists them, and answers 404 for one that is not there", async () => {
    const res = await request(app)
      .get("/manual-gl/upload-jobs")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.jobs).toEqual([]);

    await request(app)
      .get(`/manual-gl/upload-jobs/${randomUUID()}`)
      .set("X-Client-Id", companyId)
      .expect(404);
  });
});
