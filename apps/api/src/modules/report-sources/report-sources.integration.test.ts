import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { REPORT_SOURCE_KEYS } from "./ports.js";
import { createReportSourcesModule } from "./index.js";

/**
 * The source selector against a real database.
 *
 * Three things only a real Postgres proves here: that the columns read in raw
 * SQL (`data_source_type`, `quickbooks_connected`, `last_source_switch_at`) are
 * actually on `companies`, that the clear-then-set switch leaves exactly one
 * row selected, and that availability really does follow the ledger.
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
  app.use("/", createReportSourcesModule({ db, requireAuth }).router);
});

afterEach(async () => {
  await client.close();
});

const read = () => request(app).get("/report-sources").set("X-Client-Id", companyId);
const switchTo = (sourceKey: string) =>
  request(app).put("/report-sources/selected").set("X-Client-Id", companyId).send({ sourceKey });

const sourceIn = (body: { sources: Array<{ sourceKey: string }> }, key: string) =>
  body.sources.find((s) => s.sourceKey === key) as {
    sourceKey: string;
    isAvailable: boolean;
    isConnected: boolean;
    isSelected: boolean;
    sourceLabel: string;
  };

describe("report sources (real Postgres)", () => {
  it("creates the four records on first read, and only once", async () => {
    const first = await read().expect(200);
    expect(first.body.sources).toHaveLength(4);

    await read().expect(200);
    const rows = await db.select().from(schema.reportSourceRecords);
    expect(rows).toHaveLength(4);
  });

  it("labels each one for the selector", async () => {
    const res = await read().expect(200);
    expect(sourceIn(res.body, REPORT_SOURCE_KEYS.QUICKBOOKS).sourceLabel).toBe("QuickBooks Online");
    expect(sourceIn(res.body, REPORT_SOURCE_KEYS.MANUAL_GL).sourceLabel).toBe("Manual GL Upload");
  });

  it("reads the connection flag off the companies row", async () => {
    // The column is on the deployed table but not modelled, so it is named in
    // raw SQL — which either works against a real schema or does not.
    expect((await read().expect(200)).body.quickbooksConnected).toBe(false);

    await db.execute(sql`UPDATE companies SET quickbooks_connected = true WHERE id = ${companyId}`);
    const res = await read().expect(200);
    expect(res.body.quickbooksConnected).toBe(true);
    expect(sourceIn(res.body, REPORT_SOURCE_KEYS.QUICKBOOKS).isAvailable).toBe(true);
  });

  it("follows the ledger for manual-GL availability", async () => {
    expect(sourceIn((await read()).body, REPORT_SOURCE_KEYS.MANUAL_GL).isAvailable).toBe(false);

    const [version] = await db
      .insert(schema.keyReportVersions)
      .values({ companyId, versionNumber: 1 })
      .returning();
    const [folder] = await db
      .insert(schema.folders)
      .values({ companyId, name: "Financials", createdBy: BROKER.id })
      .returning();
    const [document] = await db
      .insert(schema.documents)
      .values({
        name: "gl.csv",
        companyId,
        folderId: folder!.id,
        fileUrl: "/uploads/gl.csv",
        size: "1",
        ext: "csv",
        status: "under-review" as never,
        uploadedBy: BROKER.id,
      })
      .returning();
    await db.insert(schema.generalLedgerEntries).values({
      id: 1,
      versionId: version!.id,
      companyId,
      sourceFileId: document!.id,
      accountName: "Sales",
      accountNumber: "",
      fiscalYear: 2024,
      amount: "100.00",
      rowType: "TRANSACTION",
    });

    const res = await read().expect(200);
    expect(sourceIn(res.body, REPORT_SOURCE_KEYS.MANUAL_GL).isAvailable).toBe(true);
    // Availability is not connection: there is no connection to a spreadsheet.
    expect(sourceIn(res.body, REPORT_SOURCE_KEYS.MANUAL_GL).isConnected).toBe(false);
  });

  it("follows linked documents for manual-upload availability", async () => {
    expect(sourceIn((await read()).body, REPORT_SOURCE_KEYS.MANUAL_UPLOAD).isAvailable).toBe(false);

    const [version] = await db
      .insert(schema.keyReportVersions)
      .values({ companyId, versionNumber: 1 })
      .returning();
    // `document_id` is a real foreign key, so the file has to exist — and a
    // document always lives in a folder.
    const [folder] = await db
      .insert(schema.folders)
      .values({ companyId, name: "Financials", createdBy: BROKER.id })
      .returning();
    const [document] = await db
      .insert(schema.documents)
      .values({
        name: "P&L 2024.pdf",
        companyId,
        folderId: folder!.id,
        fileUrl: "/uploads/pl.pdf",
        size: "1",
        ext: "pdf",
        status: "under-review" as never,
        uploadedBy: BROKER.id,
      })
      .returning();
    await db.insert(schema.keyReportFileMappings).values({
      versionId: version!.id,
      companyId,
      reportCategory: "profit_loss",
      documentId: document!.id,
    });

    expect(sourceIn((await read()).body, REPORT_SOURCE_KEYS.MANUAL_UPLOAD).isAvailable).toBe(true);
  });

  it("leaves exactly one selected however many times it is switched", async () => {
    for (const key of [
      REPORT_SOURCE_KEYS.MANUAL_GL,
      REPORT_SOURCE_KEYS.MANUAL_UPLOAD,
      REPORT_SOURCE_KEYS.QUICKBOOKS,
      REPORT_SOURCE_KEYS.MANUAL_GL,
    ]) {
      await switchTo(key).expect(200);
      const rows = await db.select().from(schema.reportSourceRecords);
      expect(rows.filter((r) => r.isSelected).map((r) => r.sourceKey)).toEqual([key]);
    }
  });

  it("writes the choice back to the companies cache, and stamps the switch", async () => {
    await switchTo(REPORT_SOURCE_KEYS.MANUAL_GL).expect(200);

    const result = await db.execute(
      sql`SELECT data_source_type, last_source_switch_at FROM companies WHERE id = ${companyId}`,
    );
    const [row] = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
    expect(row!["data_source_type"]).toBe(REPORT_SOURCE_KEYS.MANUAL_GL);
    expect(row!["last_source_switch_at"]).not.toBeNull();

    const res = await read().expect(200);
    expect(res.body.lastSourceSwitchAt).not.toBeNull();
  });

  it("honours a choice cached on the company before any record existed", async () => {
    await db.execute(
      sql`UPDATE companies SET data_source_type = ${REPORT_SOURCE_KEYS.MANUAL_UPLOAD} WHERE id = ${companyId}`,
    );
    const res = await read().expect(200);
    expect(res.body.selectedSource).toBe(REPORT_SOURCE_KEYS.MANUAL_UPLOAD);
    expect(res.body.manualUploadActive).toBe(true);
  });

  it("400s an unknown source and leaves the selection alone", async () => {
    await switchTo(REPORT_SOURCE_KEYS.MANUAL_GL).expect(200);
    await switchTo("quickbooks").expect(400);
    expect((await read()).body.selectedSource).toBe(REPORT_SOURCE_KEYS.MANUAL_GL);
  });

  it("403s a company the caller cannot reach", async () => {
    current = { ...BROKER, company_ids: [] };
    await read().expect(403);
    await switchTo(REPORT_SOURCE_KEYS.MANUAL_GL).expect(403);
  });
});
