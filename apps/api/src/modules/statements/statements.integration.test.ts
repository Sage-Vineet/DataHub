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
import { DrizzleStatementsRepository } from "./repository.drizzle.js";
import { createStatementsModule } from "./index.js";
import { StatementsService } from "./service.js";

/**
 * Statement extracts against a real database.
 *
 * The things only a real Postgres proves: the unique index that makes
 * re-extraction a replace, the CHECK that keeps an unknown statement type out,
 * the CASCADE that removes an extract with its document, and that the tree's
 * joins reach the document and folder names they claim to.
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
let service: StatementsService;
let current: SessionUser;
let companyId: string;
let folderId: string;

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

  const [folder] = await db
    .insert(schema.folders)
    .values({ companyId, name: "Financials", createdBy: BROKER.id })
    .returning();
  folderId = folder!.id;

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  const module = createStatementsModule({ db, requireAuth });
  app.use("/", module.router);
  service = module.service;
});

afterEach(async () => {
  await client.close();
});

async function addDocument(name: string): Promise<string> {
  const [document] = await db
    .insert(schema.documents)
    .values({
      name,
      companyId,
      folderId,
      fileUrl: `/uploads/${name}`,
      size: "1",
      ext: name.split(".").pop() ?? "pdf",
      status: "under-review" as never,
      uploadedBy: BROKER.id,
    })
    .returning();
  return document!.id;
}

const save = (documentId: string, over: Record<string, unknown> = {}) =>
  service.save(current, companyId, {
    documentId,
    statementType: "balance_sheet",
    payload: { rows: [{ name: "Cash", amount: 100 }] },
    asOfDate: "2024-12-31",
    ...over,
  });

describe("statement extracts (real Postgres)", () => {
  it("stores an extract and reads it back over HTTP", async () => {
    const documentId = await addDocument("BS 2024.pdf");
    await save(documentId);

    const res = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/latest")
      .set("X-Client-Id", companyId)
      .expect(200);

    expect(res.body.data).toEqual({ rows: [{ name: "Cash", amount: 100 }] });
    expect(res.body.documentName).toBe("BS 2024.pdf");
    expect(res.body.fiscalYear).toBe(2024);
  });

  it("replaces on re-extraction rather than accumulating", async () => {
    const documentId = await addDocument("BS 2024.pdf");
    await save(documentId, { payload: { rows: [] } });
    await save(documentId, { payload: { rows: [{ name: "Cash", amount: 999 }] } });

    const rows = await db.select().from(schema.statementExtracts);
    expect(rows).toHaveLength(1);

    const res = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/latest")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.data).toEqual({ rows: [{ name: "Cash", amount: 999 }] });
  });

  it("keeps two statement types from one file as two rows", async () => {
    const documentId = await addDocument("Both.pdf");
    await save(documentId);
    await save(documentId, { statementType: "profit_and_loss" });
    expect(await db.select().from(schema.statementExtracts)).toHaveLength(2);
  });

  it("makes re-extraction the newest, so `latest` follows the work", async () => {
    // `extractedAt` is bumped on conflict. Without that, re-extracting an old
    // document would leave a newer file winning `latest` even though the old
    // one was just reprocessed.
    const older = await addDocument("BS 2023.pdf");
    const newer = await addDocument("BS 2024.pdf");
    await save(older, { asOfDate: "2023-12-31" });
    await save(newer, { asOfDate: "2024-12-31" });
    await save(older, { asOfDate: "2023-12-31", payload: { rows: [{ name: "Redone" }] } });

    const res = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/latest")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.documentName).toBe("BS 2023.pdf");
  });

  it("refuses a statement type the CHECK constraint forbids", async () => {
    // The service refuses first; this proves the database would too, so the
    // two cannot drift apart silently.
    const documentId = await addDocument("Odd.pdf");
    await expect(
      db.insert(schema.statementExtracts).values({
        companyId,
        documentId,
        statementType: "trial_balance",
        payload: {},
      }),
    ).rejects.toThrow();
  });

  it("removes an extract when its document goes", async () => {
    // ON DELETE CASCADE rather than SET NULL: an extract whose document is
    // gone cannot be checked against anything, and keeping it would leave a
    // statement on screen with no way to see where it came from.
    const documentId = await addDocument("Doomed.pdf");
    const keeper = await addDocument("Kept.pdf");
    await save(documentId);
    await save(keeper);
    expect(await db.select().from(schema.statementExtracts)).toHaveLength(2);

    await db.delete(schema.documents).where(eq(schema.documents.id, documentId));

    const remaining = await db.select().from(schema.statementExtracts);
    expect(remaining.map((r) => r.documentId)).toEqual([keeper]);
  });

  it("resolves through a key-report version's linked document", async () => {
    const older = await addDocument("BS 2023.pdf");
    const newer = await addDocument("BS 2024.pdf");
    await save(older, { asOfDate: "2023-12-31" });
    await save(newer, { asOfDate: "2024-12-31" });

    const [version] = await db
      .insert(schema.keyReportVersions)
      .values({ companyId, versionNumber: 1 })
      .returning();
    await db.insert(schema.keyReportFileMappings).values({
      versionId: version!.id,
      companyId,
      reportCategory: "balance_sheet",
      documentId: older,
    });

    const res = await request(app)
      .get(
        `/manual-report-uploads/reports/balance_sheet/latest?keyReportVersionId=${version!.id}`,
      )
      .set("X-Client-Id", companyId)
      .expect(200);
    // The version's own document, not the newer one somebody uploaded since.
    expect(res.body.documentName).toBe("BS 2023.pdf");
  });

  it("builds a tree that reaches the document and folder names", async () => {
    const documentId = await addDocument("BS 2024.pdf");
    await save(documentId);
    await save(documentId, { statementType: "profit_and_loss" });

    const res = await request(app)
      .get("/manual-report-uploads/source-tree")
      .set("X-Client-Id", companyId)
      .expect(200);

    expect(res.body.tree).toHaveLength(1);
    expect(res.body.tree[0].documentName).toBe("BS 2024.pdf");
    expect(res.body.tree[0].folderName).toBe("Financials");
    expect(res.body.tree[0].statements).toHaveLength(2);
  });

  it("lists every extract of a type, newest first, filtered by year", async () => {
    const older = await addDocument("BS 2023.pdf");
    const newer = await addDocument("BS 2024.pdf");
    await save(older, { asOfDate: "2023-12-31" });
    await save(newer, { asOfDate: "2024-12-31" });

    const all = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(all.body.reports.map((r: { documentName: string }) => r.documentName)).toEqual([
      "BS 2024.pdf",
      "BS 2023.pdf",
    ]);

    const only2023 = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all?fiscalYear=2023")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(only2023.body.reports).toHaveLength(1);
  });

  it("keeps one source's extracts off another's page", async () => {
    const documentId = await addDocument("QB.pdf");
    await save(documentId, { sourceKey: "quickbooks_online" });

    await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/latest?sourceKey=manual_upload_excel_pdf")
      .set("X-Client-Id", companyId)
      .expect(404);
    await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/latest?sourceKey=quickbooks_online")
      .set("X-Client-Id", companyId)
      .expect(200);
  });

  it("404s a company with nothing extracted, and 403s one it cannot reach", async () => {
    await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/latest")
      .set("X-Client-Id", companyId)
      .expect(404);

    current = { ...BROKER, company_ids: [] };
    await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/latest")
      .set("X-Client-Id", companyId)
      .expect(403);
  });

  it("reads back the same extract through the repository, joined to its document", async () => {
    const documentId = await addDocument("BS 2024.pdf");
    const saved = await save(documentId);

    const repo = new DrizzleStatementsRepository(db);
    const found = await repo.getById(companyId, saved.id);
    expect(found?.documentName).toBe("BS 2024.pdf");
    expect(found?.payload).toEqual({ rows: [{ name: "Cash", amount: 100 }] });
  });
});
