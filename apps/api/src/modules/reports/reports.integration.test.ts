import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createReportsModule } from "./index.js";


const BROKER: SessionUser = { id: "11111111-1111-1111-1111-111111111111", name: "B", email: "b@x.com", role: "broker", company_id: null, status: "active", company_ids: [] };

let client: PGlite;
let db: Db;
let app: express.Express;
let current: SessionUser;
let companyId: string;

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;
  // The acting user needs a row: the deployed schema's foreign keys are real,
  // so anything created on their behalf points at a person who has to exist.
  await db.insert(schema.users).values({
    id: BROKER.id, name: BROKER.name, email: `${BROKER.id}@x.test`,
    passwordHash: "!", role: "broker",
  });
  companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });
  current = { ...BROKER, company_ids: [companyId] };
  const requireAuth = (req: Request, _res: Response, next: NextFunction) => { req.user = current; next(); };
  app = express();
  app.use("/", createReportsModule({ db, requireAuth }).router);
});
afterEach(async () => { await client.close(); });

describe("reports router — version lifecycle (real Postgres)", () => {
  it("creates (auto-numbered), lists, updates, duplicates, and enforces one active version", async () => {
    const v1 = (await request(app).post("/key-reports/versions").send({ company_id: companyId, version_name: "First" })).body;
    const v2 = (await request(app).post("/key-reports/versions").send({ company_id: companyId })).body;
    // Legacy wire shape is camelCase — the SPA reads these names directly.
    expect([v1.versionNumber, v2.versionNumber]).toEqual([1, 2]);

    // Legacy envelope: { success, versions, activeVersionId }.
    const listed = (await request(app).get(`/key-reports/versions?company_id=${companyId}`)).body;
    expect(listed.success).toBe(true);
    expect(listed.versions.length).toBe(2);
    expect(listed.activeVersionId).toBeNull();

    // The SPA sends the company as X-Client-Id, never as ?company_id.
    const viaHeader = await request(app)
      .get("/key-reports/versions")
      .set("X-Client-Id", companyId);
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.versions.length).toBe(2);

    await request(app).put(`/key-reports/versions/${v1.id}`).send({ status: "synced", metadata: { note: "x" } }).expect(200);

    // Legacy envelope for the detail read — the SPA store reads `detail.version`.
    const detail = (await request(app).get(`/key-reports/versions/${v1.id}`)).body;
    expect(detail.success).toBe(true);
    expect(detail.version.id).toBe(v1.id);
    expect(detail.version.versionName).toBe("First");

    const dup = (await request(app).post(`/key-reports/versions/${v1.id}/duplicate`)).body;
    expect(dup.versionNumber).toBe(3);
    expect(dup.isActive).toBe(false);
    expect(dup.versionName).toBe("First");

    // Activate v1, then v2 — the partial-unique index means only one stays active.
    await request(app).post(`/key-reports/versions/${v1.id}/activate`).expect(200);
    await request(app).post(`/key-reports/versions/${v2.id}/activate`).expect(200);
    const active = (await db.select().from(schema.keyReportVersions)).filter((r) => r.isActive);
    expect(active.map((r) => r.id)).toEqual([v2.id]);
  });

  it("400s malformed create, 403s cross-tenant, and 501s the deferred sync via fall-through", async () => {
    const v = (await request(app).post("/key-reports/versions").send({ company_id: companyId })).body;
    expect((await request(app).post("/key-reports/versions").send({})).status).toBe(400);
    current = { ...BROKER, role: "buyer", company_ids: [randomUUID()] };
    expect((await request(app).get(`/key-reports/versions?company_id=${companyId}`)).status).toBe(403);
    // The sync route is NOT defined here (falls through to legacy in prod); the module
    // never handles it, so a direct call 404s on this isolated app — proving it's not migrated.
    current = { ...BROKER, company_ids: [companyId] };
    expect((await request(app).post(`/key-reports/versions/${v.id}/sync`)).status).toBe(404);
  });
});

/**
 * The reports over a real ledger.
 *
 * The presenters are unit-tested against fixtures; what is only checkable here
 * is the SQL underneath them — that the drill-down reads the right rows, keeps
 * the sign convention the engine expects, and returns null for the columns the
 * extractor leaves empty rather than a confident zero.
 */
describe("reports over a real ledger (real Postgres)", () => {
  const ACCOUNTS = {
    cash: randomUUID(),
    sales: randomUUID(),
    rent: randomUUID(),
  };
  let versionId: string;

  beforeEach(async () => {
    versionId = (
      await request(app).post("/key-reports/versions").send({ company_id: companyId })
    ).body.id;
    await request(app).post(`/key-reports/versions/${versionId}/activate`).send({});

    await db.insert(schema.chartOfAccounts).values([
      { id: ACCOUNTS.cash, versionId, companyId, accountName: "Operating Cash", accountType: "asset", statementType: "balance_sheet" },
      { id: ACCOUNTS.sales, versionId, companyId, accountName: "Sales", accountType: "income", statementType: "profit_loss" },
      { id: ACCOUNTS.rent, versionId, companyId, accountName: "Rent", accountType: "expense", statementType: "profit_loss" },
    ]);

    // `general_ledger_entries.source_file_id` is NOT NULL and references
    // `documents`: every posted row came out of a file somebody uploaded, and
    // a document always lives in a folder.
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
        // `documents.size` is a text column, not numeric.
        size: "1",
        ext: "csv",
        // The deployed `document_status` enum is verified|under-review|rejected.
        status: "under-review" as never,
        uploadedBy: BROKER.id,
      })
      .returning();
    const sourceFileId = document!.id;

    // `id` is supplied explicitly: the column is sequence-backed in the
    // database but modelled as a plain bigint primary key, so Drizzle requires
    // it. Same as the QoE suite does.
    await db.insert(schema.generalLedgerEntries).values([
      { id: 1, versionId, companyId, sourceFileId, coaId: ACCOUNTS.sales, fiscalYear: 2024, transactionDate: "2024-01-15", accountName: "Sales", accountNumber: "", amount: "1000.00", rowType: "TRANSACTION", vendor: "Northwind" },
      { id: 2, versionId, companyId, sourceFileId, coaId: ACCOUNTS.cash, fiscalYear: 2024, transactionDate: "2024-01-15", accountName: "Operating Cash", accountNumber: "", amount: "1000.00", rowType: "TRANSACTION" },
      { id: 3, versionId, companyId, sourceFileId, coaId: ACCOUNTS.rent, fiscalYear: 2024, transactionDate: "2024-02-01", accountName: "Rent", accountNumber: "", amount: "400.00", rowType: "TRANSACTION" },
      // A summary row. Counting it would double the rent.
      { id: 4, versionId, companyId, sourceFileId, coaId: ACCOUNTS.rent, fiscalYear: 2024, transactionDate: "2024-02-28", accountName: "Rent", accountNumber: "", amount: "400.00", rowType: "TOTAL_ROW" },
    ]);
  });

  it("serves a P&L from the ledger, for the company's active version", async () => {
    const res = await request(app)
      .get("/reports/profit-loss")
      .set("X-Client-Id", companyId)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.netProfitByYear["2024"]).toBeCloseTo(600, 2);
  });

  it("leaves summary rows out, rather than counting them twice", async () => {
    // `row_type` is the only thing separating a posting from a subtotal, and
    // the subtotal here is the same amount as the posting it summarizes.
    const res = await request(app)
      .get("/reports/profit-loss")
      .set("X-Client-Id", companyId)
      .expect(200);
    const comparison = res.body.yearComparison.find(
      (r: { fiscalYear: number }) => r.fiscalYear === 2024,
    );
    expect(comparison.operatingExpenses).toBeCloseTo(400, 2);
  });

  it("reads the drill-down from the ledger, and nulls what the extractor left empty", async () => {
    const res = await request(app)
      .get("/reports/profit-loss/monthly-detail?fiscalYear=2024")
      .set("X-Client-Id", companyId)
      .expect(200);

    const income = res.body.sections.find((s: { key: string }) => s.key === "income");
    const sales = income.accounts.find(
      (a: { accountName: string }) => a.accountName === "Sales",
    );
    expect(sales.monthly["1"]).toBeCloseTo(1000, 2);

    const [row] = sales.transactions;
    expect(row.vendorName).toBe("Northwind");
    expect(row.date).toBe("2024-01-15");
    // The columns exist and hold nothing. `debit` and `credit` are DEFAULT 0,
    // so an extractor that never wrote them leaves a zero on both sides of a
    // 1,000 transaction — which reads as "this was zero either way" rather
    // than "nobody recorded which side it fell on". Both zero against a
    // non-zero amount is reported as absent.
    expect(row.description).toBeNull();
    expect(row.debit).toBeNull();
    expect(row.credit).toBeNull();
  });

  it("keeps a real debit/credit split when the extractor recorded one", async () => {
    // The absence rule must not swallow a split that is actually there.
    const [document] = await db.select().from(schema.documents).limit(1);
    await db.insert(schema.generalLedgerEntries).values({
      id: 99,
      versionId,
      companyId,
      sourceFileId: document!.id,
      coaId: ACCOUNTS.rent,
      fiscalYear: 2024,
      transactionDate: "2024-03-01",
      accountName: "Rent",
      accountNumber: "",
      amount: "250.00",
      rowType: "TRANSACTION",
      debit: "250.00",
      credit: "0.00",
    });

    const res = await request(app)
      .get("/reports/profit-loss/monthly-detail?fiscalYear=2024")
      .set("X-Client-Id", companyId)
      .expect(200);
    const expenses = res.body.sections.find((s: { key: string }) => s.key === "expenses");
    const rent = expenses.accounts.find(
      (a: { accountName: string }) => a.accountName === "Rent",
    );
    const march = rent.transactions.find((t: { date: string }) => t.date === "2024-03-01");
    expect(march.debit).toBeCloseTo(250, 2);
    expect(march.credit).toBeCloseTo(0, 2);
  });

  it("offers filter options drawn from the ledger itself", async () => {
    const res = await request(app)
      .get("/manual-gl/staging/filter-options")
      .set("X-Client-Id", companyId)
      .expect(200);

    expect(res.body.options.fiscalYear).toEqual([2024]);
    expect(res.body.options.fiscalMonth).toEqual([1, 2]);
    expect(res.body.options.accountName).toEqual(["Operating Cash", "Rent", "Sales"]);
    // Nothing populates these, and an empty list says exactly that.
    expect(res.body.options.journalType).toEqual([]);
  });

  it("reports spend by vendor, tying to the same net profit", async () => {
    const res = await request(app)
      .get("/reports/profit-loss/detail-vendor")
      .set("X-Client-Id", companyId)
      .expect(200);

    const northwind = res.body.vendors.find(
      (v: { vendorName: string }) => v.vendorName === "Northwind",
    );
    expect(northwind.totalAmount).toBeCloseTo(1000, 2);
    const total = res.body.vendors.reduce(
      (sum: number, v: { totalAmount: number }) => sum + v.totalAmount,
      0,
    );
    expect(total).toBeCloseTo(600, 2);
  });

  it("refuses the balance sheet when none has been ingested", async () => {
    // A roll-forward from nothing balances perfectly and is wrong throughout.
    await request(app)
      .get("/reports/balance-sheet")
      .set("X-Client-Id", companyId)
      .expect(422);
  });

  it("reports the missing sheet as a validation finding, not an error", async () => {
    const res = await request(app)
      .get("/manual-gl/validation/balance-sheet")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.validation.missingSheets).toEqual(["starting", "ending"]);
    expect(res.body.validation.isValid).toBe(false);
  });

  it("404s a company with no key-report version at all", async () => {
    const other = randomUUID();
    await db.insert(schema.companies).values({ id: other, name: "Other", industry: "" });
    current = { ...BROKER, company_ids: [companyId, other] };
    await request(app).get("/reports/profit-loss").set("X-Client-Id", other).expect(404);
  });

  it("403s a company the caller cannot reach", async () => {
    current = { ...BROKER, company_ids: [] };
    await request(app).get("/reports/profit-loss").set("X-Client-Id", companyId).expect(403);
  });
});
