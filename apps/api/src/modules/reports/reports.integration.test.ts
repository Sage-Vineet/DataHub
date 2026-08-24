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
    // Legacy answers `{ success, version }` and the SPA store reads `.version`.
    const v1 = (await request(app).post("/key-reports/versions").send({ company_id: companyId, version_name: "First" })).body.version;
    const v2 = (await request(app).post("/key-reports/versions").send({ company_id: companyId })).body.version;
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

    // Same envelope, and for a concrete reason: the Key Reports page reads
    // `res.version.id` to select the copy it just made.
    const dup = (await request(app).post(`/key-reports/versions/${v1.id}/duplicate`)).body;
    expect(dup.success).toBe(true);
    expect(dup.version.id).toBeTruthy();
    expect(dup.version.versionNumber).toBe(3);
    expect(dup.version.isActive).toBe(false);
    expect(dup.version.versionName).toBe("First");

    // Activate v1, then v2 — the partial-unique index means only one stays active.
    await request(app).post(`/key-reports/versions/${v1.id}/activate`).expect(200);
    await request(app).post(`/key-reports/versions/${v2.id}/activate`).expect(200);
    const active = (await db.select().from(schema.keyReportVersions)).filter((r) => r.isActive);
    expect(active.map((r) => r.id)).toEqual([v2.id]);
  });

  it("accepts the camelCase body the SPA actually sends", async () => {
    // `createKeyReportVersion(clientId, {})` sends `{ companyId }`, and legacy
    // read `req.body.versionName`. The contract wants `company_id` and
    // `version_name`, so "New version" answered 400 for every caller the moment
    // the module served this route — and the demo sets the flag that makes it.
    const created = await request(app)
      .post("/key-reports/versions")
      .send({ companyId, versionName: "From the SPA" })
      .expect(201);
    expect(created.body.version.versionName).toBe("From the SPA");
    expect(created.body.version.companyId).toBe(companyId);
  });

  it("takes the company from X-Client-Id on create, as it does on list", async () => {
    const created = await request(app)
      .post("/key-reports/versions")
      .set("X-Client-Id", companyId)
      .send({})
      .expect(201);
    expect(created.body.version.companyId).toBe(companyId);
  });

  it("accepts a camelCase rename", async () => {
    const id = (
      await request(app).post("/key-reports/versions").send({ company_id: companyId })
    ).body.version.id;
    const updated = await request(app)
      .put(`/key-reports/versions/${id}`)
      .send({ versionName: "Renamed" })
      .expect(200);
    expect(updated.body.version.versionName).toBe("Renamed");
  });

  it("400s malformed create, 403s cross-tenant, and 503s a sync with no model", async () => {
    const v = (await request(app).post("/key-reports/versions").send({ company_id: companyId })).body;
    expect((await request(app).post("/key-reports/versions").send({})).status).toBe(400);
    current = { ...BROKER, role: "buyer", company_ids: [randomUUID()] };
    expect((await request(app).get(`/key-reports/versions?company_id=${companyId}`)).status).toBe(403);
    // The sync IS the module's now. This harness has no model configured, so
    // it answers 503 naming the configuration rather than 404ing to legacy.
    current = { ...BROKER, company_ids: [companyId] };
    // `v.version.id`, not `v.id`: the create answers `{ success, version }`.
    // While the sync route 404'd, an undefined id here reached nothing and the
    // assertion passed for the wrong reason.
    expect((await request(app).post(`/key-reports/versions/${v.version.id}/sync`)).status).toBe(
      503,
    );
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
    ).body.version.id;
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

/**
 * Mappings against a real database.
 *
 * The two behaviours worth a real Postgres are the ones enforced by the schema
 * rather than by code: the unique index that makes re-linking a no-op, and the
 * file-reference row that stops the Data Room deleting a file somebody's report
 * depends on.
 */
describe("key-report mappings (real Postgres)", () => {
  let versionId: string;
  let documentId: string;

  beforeEach(async () => {
    versionId = (
      await request(app).post("/key-reports/versions").send({ company_id: companyId })
    ).body.version.id;

    const [folder] = await db
      .insert(schema.folders)
      .values({ companyId, name: "Financials", createdBy: BROKER.id })
      .returning();
    const [document] = await db
      .insert(schema.documents)
      .values({
        name: "Balance Sheet Jan 24.pdf",
        companyId,
        folderId: folder!.id,
        fileUrl: "/uploads/bs.pdf",
        size: "1",
        ext: "pdf",
        status: "under-review" as never,
        uploadedBy: BROKER.id,
      })
      .returning();
    documentId = document!.id;
  });

  const references = () => db.select().from(schema.fileReferences);

  it("links a document and infers its year from the name", async () => {
    // "Jan 24" — the two-digit form legacy's month-year regex never matched,
    // because it was built from a string literal and compiled as `[s._-]*(d{2,4})`.
    const res = await request(app)
      .post(`/key-reports/versions/${versionId}/mappings`)
      .send({ reportCategory: "balance_sheet", documentId })
      .expect(201);

    expect(res.body.mappings[0].year).toBe(2024);
    expect(res.body.mappings[0].fileName).toBe("Balance Sheet Jan 24.pdf");
  });

  it("holds the file in place, once, however many times it is linked", async () => {
    // Stacking references would leave the count permanently above zero and the
    // document undeletable forever.
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/key-reports/versions/${versionId}/mappings`)
        .send({ reportCategory: "balance_sheet", documentId })
        .expect(201);
    }
    expect(await references()).toHaveLength(1);

    const grouped = (
      await request(app).get(`/key-reports/versions/${versionId}/mappings`).expect(200)
    ).body.mappingsByCategory;
    // The unique index does the work; the row count proves it did.
    expect(grouped.balance_sheet).toHaveLength(1);
  });

  it("releases the file only when the last category lets go of it", async () => {
    await request(app)
      .post(`/key-reports/versions/${versionId}/mappings`)
      .send({ reportCategory: "balance_sheet", documentId })
      .expect(201);
    await request(app)
      .post(`/key-reports/versions/${versionId}/mappings`)
      .send({ reportCategory: "general_ledger", documentId })
      .expect(201);

    const grouped = (
      await request(app).get(`/key-reports/versions/${versionId}/mappings`)
    ).body.mappingsByCategory;

    await request(app)
      .delete(`/key-reports/mappings/${grouped.balance_sheet[0].id}`)
      .expect(204);
    expect(await references()).toHaveLength(1);

    await request(app)
      .delete(`/key-reports/mappings/${grouped.general_ledger[0].id}`)
      .expect(204);
    expect(await references()).toHaveLength(0);
  });

  it("refuses a document from another company", async () => {
    const other = randomUUID();
    await db.insert(schema.companies).values({ id: other, name: "Other", industry: "" });
    const [folder] = await db
      .insert(schema.folders)
      .values({ companyId: other, name: "Theirs", createdBy: BROKER.id })
      .returning();
    const [foreign] = await db
      .insert(schema.documents)
      .values({
        name: "Theirs.pdf",
        companyId: other,
        folderId: folder!.id,
        fileUrl: "/uploads/theirs.pdf",
        size: "1",
        ext: "pdf",
        status: "under-review" as never,
        uploadedBy: BROKER.id,
      })
      .returning();

    await request(app)
      .post(`/key-reports/versions/${versionId}/mappings`)
      .send({ reportCategory: "profit_loss", documentId: foreign!.id })
      .expect(403);
    expect(await references()).toHaveLength(0);
  });

  it("404s a document that is not in the Data Room at all", async () => {
    await request(app)
      .post(`/key-reports/versions/${versionId}/mappings`)
      .send({ reportCategory: "profit_loss", documentId: randomUUID() })
      .expect(404);
  });
});

/**
 * The raw rows behind a version, against the real tables.
 *
 * Paging and searching are where a caller's input reaches a query, and they
 * are also where an off-by-one silently drops or repeats rows between pages —
 * which nobody notices, because both pages look full.
 */
describe("extracted data (real Postgres)", () => {
  let versionId: string;
  let documentId: string;

  const seedPl = async (rows: Array<{ name: string; year: number; sort: number }>) => {
    for (const row of rows) {
      await db.insert(schema.profitLossEntries).values({
        versionId,
        companyId,
        sourceFileId: documentId,
        fiscalYear: row.year,
        accountName: row.name,
        amount: "100.00",
        sortOrder: row.sort,
      });
    }
  };

  beforeEach(async () => {
    const [version] = await db
      .insert(schema.keyReportVersions)
      .values({ companyId, versionNumber: 1 })
      .returning();
    versionId = version!.id;

    const [folder] = await db
      .insert(schema.folders)
      .values({ companyId, name: "Financials", createdBy: BROKER.id })
      .returning();
    const [document] = await db
      .insert(schema.documents)
      .values({
        companyId,
        folderId: folder!.id,
        name: "PL.pdf",
        fileUrl: "/uploads/PL.pdf",
        size: "1",
        ext: "pdf",
        status: "under-review" as never,
        uploadedBy: BROKER.id,
      })
      .returning();
    documentId = document!.id;
  });

  const read = (query: string) =>
    request(app).get(`/key-reports/versions/${versionId}/extracted-data?${query}`);

  it("reads a page and reports how many match", async () => {
    await seedPl([
      { name: "Sales", year: 2024, sort: 1 },
      { name: "Rent", year: 2024, sort: 2 },
      { name: "Wages", year: 2024, sort: 3 },
    ]);

    const res = await read("dataType=profit_loss&pageSize=2").expect(200);
    expect(res.body.rows).toHaveLength(2);
    // How many match the filter, not how many are on this page — "showing 2 of
    // 3" is about the question asked.
    expect(res.body.total).toBe(3);
    expect(res.body.totalPages).toBe(2);
  });

  it("does not drop or repeat a row across a page boundary", async () => {
    // Sort orders repeat, and a boundary inside a group of equal keys drops or
    // repeats rows with nothing to indicate it — both pages look full.
    await seedPl([
      { name: "A", year: 2024, sort: 1 },
      { name: "B", year: 2024, sort: 1 },
      { name: "C", year: 2024, sort: 1 },
      { name: "D", year: 2024, sort: 1 },
    ]);

    const first = await read("dataType=profit_loss&pageSize=2&page=1").expect(200);
    const second = await read("dataType=profit_loss&pageSize=2&page=2").expect(200);
    const names = [...first.body.rows, ...second.body.rows].map(
      (r: { accountName: string }) => r.accountName,
    );
    expect(new Set(names).size).toBe(4);
  });

  it("narrows to a fiscal year", async () => {
    await seedPl([
      { name: "Sales", year: 2023, sort: 1 },
      { name: "Sales", year: 2024, sort: 1 },
    ]);
    const res = await read("dataType=profit_loss&year=2024").expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].fiscalYear).toBe(2024);
  });

  it("narrows a bank statement by the MONTH it covers, which is a date", async () => {
    // The column is a date, and comparing it to an integer year matches
    // nothing — which reads as a year with no transactions rather than as a
    // question asked wrongly.
    for (const month of ["2023-06-01", "2024-06-01"]) {
      await db.insert(schema.bankStatementEntries).values({
        versionId,
        companyId,
        sourceFileId: documentId,
        statementDate: month,
        statementMonth: month,
        bankAccount: "Current",
        transactionDate: month,
        amount: "10.00",
      });
    }
    const res = await read("dataType=bank_statement&year=2024").expect(200);
    expect(res.body.total).toBe(1);
  });

  it("searches across the columns a person would search", async () => {
    await seedPl([
      { name: "Rent — Office", year: 2024, sort: 1 },
      { name: "Wages", year: 2024, sort: 2 },
    ]);
    const res = await read("dataType=profit_loss&search=rent").expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].accountName).toBe("Rent — Office");
  });

  it("treats a wildcard in the search as a character, not as a wildcard", async () => {
    // Unescaped, searching for "50%" matches every account starting "50".
    await seedPl([
      { name: "50% Owner Draw", year: 2024, sort: 1 },
      { name: "5000 Cost of Sales", year: 2024, sort: 2 },
    ]);
    const res = await read("dataType=profit_loss&search=50%25").expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].accountName).toBe("50% Owner Draw");
  });

  it("takes a search term with a comma literally", async () => {
    // Legacy joined its filter with commas, so a comma changed the filter's
    // structure rather than what it searched for.
    await seedPl([{ name: "Smith, J", year: 2024, sort: 1 }]);
    const res = await read("dataType=profit_loss&search=Smith%2C%20J").expect(200);
    expect(res.body.total).toBe(1);
  });

  it("keeps one version's rows off another's page", async () => {
    const [other] = await db
      .insert(schema.keyReportVersions)
      .values({ companyId, versionNumber: 2 })
      .returning();
    await seedPl([{ name: "Ours", year: 2024, sort: 1 }]);
    await db.insert(schema.profitLossEntries).values({
      versionId: other!.id,
      companyId,
      sourceFileId: documentId,
      fiscalYear: 2024,
      accountName: "Theirs",
      amount: "1.00",
    });

    const res = await read("dataType=profit_loss").expect(200);
    expect(res.body.rows.map((r: { accountName: string }) => r.accountName)).toEqual(["Ours"]);
  });

  it("400s an unknown data type rather than reaching a query", async () => {
    await read("dataType=users").expect(400);
    await read("").expect(400);
  });

  it("answers an empty page rather than failing when there is nothing", async () => {
    const res = await read("dataType=tax_return").expect(200);
    expect(res.body).toMatchObject({ rows: [], total: 0, totalPages: 1 });
  });

  it("403s a version the caller cannot reach", async () => {
    current = { ...current, company_ids: [] };
    await read("dataType=profit_loss").expect(403);
  });
});
