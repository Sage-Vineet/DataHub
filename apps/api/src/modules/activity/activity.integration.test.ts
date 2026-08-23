import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createActivityModule } from "./index.js";

/**
 * The broker feed against the real schema.
 *
 * Six queries, plus two resolution passes for company and actor names. The
 * failure this is really guarding is a scoping one: the narrative source has no
 * company column, so it is queried unscoped and filtered by resolving its
 * request. Get that wrong and a broker sees another tenant's request titles —
 * which no in-memory fake would reveal, because the fake is handed
 * already-scoped rows.
 */

const MINE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const THEIRS = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const BROKER_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_ID = "22222222-2222-2222-2222-222222222222";

const broker: SessionUser = {
  id: BROKER_ID,
  name: "Broker",
  email: "broker@example.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [MINE],
};

let client: PGlite;
let db: Db;
let app: express.Express;
let current: SessionUser;

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;
  current = { ...broker };

  await db.insert(schema.companies).values([
    { id: MINE, name: "Acme", projectName: "Project Falcon", industry: "Manufacturing" },
    { id: THEIRS, name: "Rival", industry: "Retail" },
  ]);
  await db.insert(schema.users).values([
    { id: BROKER_ID, name: "Dana", email: "d@x.test", passwordHash: "!", role: "broker" },
    { id: CLIENT_ID, name: "Sam", email: "s@x.test", passwordHash: "!", role: "buyer", companyId: MINE },
  ]);

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  app.use(createActivityModule({ db, requireAuth }).router);
});

const api = () => supertest(app);

describe("the feed a broker gets", () => {
  it("includes their own companies and the people on them", async () => {
    const body = (await api().get("/broker/activity").expect(200)).body as Array<{
      type: string;
      message: string;
      detail: string | null;
    }>;

    const company = body.find((e) => e.type === "company_created");
    // The project name, not the legal name — that is what a broker calls it.
    expect(company?.message).toBe("Company added: Project Falcon");
    expect(body.find((e) => e.type === "user_added")?.message).toBe("Client added: Sam");
  });

  it("excludes a company they are not on", async () => {
    const body = (await api().get("/broker/activity").expect(200)).body as Array<{
      message: string;
    }>;
    expect(body.some((e) => e.message.includes("Rival"))).toBe(false);
  });

  it("resolves the actor's name on an upload", async () => {
    const [upload] = await db
      .insert(schema.uploads)
      .values({
        fileName: "q1.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        data: Buffer.from("x"),
      })
      .returning();
    // `documents.folder_id` is NOT NULL: a document always lives somewhere.
    const [folder] = await db
      .insert(schema.folders)
      .values({ companyId: MINE, name: "Financials", createdBy: BROKER_ID })
      .returning();
    await db.insert(schema.documents).values({
      name: "Q1.pdf",
      companyId: MINE,
      folderId: folder!.id,
      fileUrl: `/uploads/${upload!.id}/content`,
      // `documents.size` is a text column, not numeric.
      size: "1",
      ext: "pdf",
      // The deployed `document_status` enum is verified|under-review|rejected.
      // `packages/db` declares active|processing|error and shares no value with
      // it — see the comment on `uploads/repository.drizzle.ts:createDocument`.
      status: "under-review" as never,
      uploadId: upload!.id,
      uploadedBy: BROKER_ID,
    });

    const body = (await api().get("/broker/activity").expect(200)).body as Array<{
      type: string;
      actor_name: string | null;
      detail: string | null;
    }>;
    const doc = body.find((e) => e.type === "document_uploaded");
    expect(doc).toMatchObject({ actor_name: "Dana", detail: "Project Falcon" });
  });

  it("keeps another tenant's request title out of the narrative source", async () => {
    // The scoping failure this file exists for: narratives carry no company, so
    // they are read unscoped and filtered by resolving the request.
    const [theirs] = await db
      .insert(schema.requests)
      .values({
        title: "Rival's confidential ask",
        description: "confidential",
        companyId: THEIRS,
        category: "Finance",
        responseType: "Upload",
        priority: "high",
        status: "pending",
        dueDate: "2099-01-01",
        createdBy: BROKER_ID,
      })
      .returning();
    await db
      .insert(schema.requestNarratives)
      .values({ requestId: theirs!.id, content: "secret", updatedBy: BROKER_ID });

    const body = (await api().get("/broker/activity").expect(200)).body as Array<{
      message: string;
    }>;
    expect(body.some((e) => e.message.includes("Rival's confidential ask"))).toBe(false);
  });

  it("shows a narrative on a request they can see", async () => {
    const [mine] = await db
      .insert(schema.requests)
      .values({
        title: "Send Q1",
        description: "please send",
        companyId: MINE,
        category: "Finance",
        responseType: "Upload",
        priority: "high",
        status: "pending",
        dueDate: "2099-01-01",
        createdBy: BROKER_ID,
      })
      .returning();
    await db
      .insert(schema.requestNarratives)
      .values({ requestId: mine!.id, content: "done", updatedBy: BROKER_ID });

    const body = (await api().get("/broker/activity").expect(200)).body as Array<{
      type: string;
      message: string;
    }>;
    expect(body.find((e) => e.type === "request_narrative_updated")?.message).toBe(
      "Request answered: Send Q1",
    );
  });

  it("honours the limit and numbers the page", async () => {
    const res = await api().get("/broker/activity?limit=1").expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sequence).toBe(1);
    expect(res.headers["cache-control"]).toBe("private, max-age=15");
  });
});

describe("the feed an admin gets", () => {
  it("spans every company", async () => {
    current = { ...broker, role: "admin", company_ids: [] };
    const body = (await api().get("/broker/activity").expect(200)).body as Array<{
      message: string;
    }>;
    expect(body.some((e) => e.message.includes("Rival"))).toBe(true);
    expect(body.some((e) => e.message.includes("Project Falcon"))).toBe(true);
  });
});

describe("who is refused", () => {
  it("403s a client", async () => {
    current = { ...broker, role: "buyer" };
    await api().get("/broker/activity").expect(403);
  });

  it("leaves an unmatched path for the proxy", async () => {
    await api().get("/companies/x/activity").expect(404);
  });
});
