import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import { createChartOfAccountsModule } from "./index.js";

/**
 * Rebuilding a chart of accounts, against the real tables.
 *
 * The classification is tested without a database in `generate.test.ts`. What
 * is left here is what only a real store can show: that a rebuild does not
 * destroy what a person edited, that stale accounts go, and that the unique
 * indexes actually stop an account being added twice — which for an
 * UNNUMBERED account they did not, until migration 0018.
 */

const BROKER: SessionUser = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Bea",
  email: "bea@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [],
};

let client: PGlite;
let db: Db;
let app: express.Express;
let companyId: string;
let versionId: string;
let documentId: string;
let current: SessionUser;

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;

  await db.insert(schema.users).values({
    id: BROKER.id,
    name: BROKER.name,
    email: BROKER.email,
    passwordHash: "!",
    role: "broker",
  });
  companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });
  current = { ...BROKER, company_ids: [companyId] };

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
      name: "GL.csv",
      fileUrl: "/uploads/GL.csv",
      size: "1",
      ext: "csv",
      status: "under-review" as never,
      uploadedBy: BROKER.id,
    })
    .returning();
  documentId = document!.id;

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  app.use("/", createChartOfAccountsModule({ db, requireAuth }).router);
});

afterEach(async () => {
  await client.close();
});

const addLedgerRow = (over: Record<string, unknown> = {}) =>
  db.insert(schema.generalLedgerEntries).values({
    versionId,
    companyId,
    sourceFileId: documentId,
    transactionDate: "2024-06-01",
    fiscalYear: 2024,
    accountName: "Office Rent",
    accountNumber: "",
    amount: "100.00",
    ...over,
  });

const addPlRow = (over: Record<string, unknown> = {}) =>
  db.insert(schema.profitLossEntries).values({
    versionId,
    companyId,
    sourceFileId: documentId,
    fiscalYear: 2024,
    accountName: "Office Rent",
    amount: "100.00",
    ...over,
  });

const rebuild = () =>
  request(app).post(`/key-reports/versions/${versionId}/chart-of-accounts/regenerate`);

const stored = () =>
  db.select().from(schema.chartOfAccounts).where(eq(schema.chartOfAccounts.versionId, versionId));

describe("rebuilding the chart (real Postgres)", () => {
  it("builds one account per distinct account across every entry table", async () => {
    await addLedgerRow({ accountName: "Office Rent" });
    await addLedgerRow({ accountName: "Wages" });
    await addPlRow({ accountName: "office rent " });
    await db.insert(schema.balanceSheetEntries).values({
      versionId,
      companyId,
      sourceFileId: documentId,
      asOfDate: "2024-12-31",
      fiscalYear: 2024,
      accountName: "Business Checking",
      accountType: "asset",
      amount: "500.00",
    });

    const res = await rebuild().expect(200);
    expect(res.body.accountCount).toBe(3);
    expect((await stored()).map((r) => r.accountName).sort()).toEqual([
      "Business Checking",
      "Office Rent",
      "Wages",
    ]);
  });

  it("answers the rebuilt chart, not just a count", async () => {
    // The page that triggers this is showing the chart; making it ask again is
    // a second round trip during which the two can disagree.
    await addLedgerRow();
    const res = await rebuild().expect(200);
    expect(res.body.flat).toHaveLength(1);
    expect(res.body.tree).toBeDefined();
  });

  it("keeps what a person edited", async () => {
    // A renamed or moved account cannot be recovered from anything, unlike
    // everything the rules produce.
    await addLedgerRow();
    await rebuild().expect(200);

    const [account] = await stored();
    await db
      .update(schema.chartOfAccounts)
      .set({ adjustedName: "Rent — Head Office", isActive: false })
      .where(eq(schema.chartOfAccounts.id, account!.id));

    await rebuild().expect(200);

    const [after] = await stored();
    expect(after!.id).toBe(account!.id);
    expect(after!.adjustedName).toBe("Rent — Head Office");
    expect(after!.isActive).toBe(false);
  });

  it("recomputes what the rules produce", async () => {
    await addLedgerRow();
    await rebuild().expect(200);
    await db
      .update(schema.chartOfAccounts)
      .set({ accountType: "asset", hierarchyPath: "Nonsense" })
      .where(eq(schema.chartOfAccounts.versionId, versionId));

    await rebuild().expect(200);
    const [after] = await stored();
    expect(after!.accountType).toBe("expense");
    expect(after!.hierarchyPath).toContain("Occupancy");
  });

  it("removes an account the entries no longer mention", async () => {
    await addLedgerRow({ accountName: "Office Rent" });
    await addLedgerRow({ accountName: "Discontinued Line" });
    await rebuild().expect(200);
    expect(await stored()).toHaveLength(2);

    await db
      .delete(schema.generalLedgerEntries)
      .where(eq(schema.generalLedgerEntries.accountName, "Discontinued Line"));

    const res = await rebuild().expect(200);
    expect(res.body.removedCount).toBe(1);
    expect((await stored()).map((r) => r.accountName)).toEqual(["Office Rent"]);
  });

  it("clears the chart when nothing is left to build from", async () => {
    await addLedgerRow();
    await rebuild().expect(200);
    await db.delete(schema.generalLedgerEntries);

    const res = await rebuild().expect(200);
    expect(res.body.accountCount).toBe(0);
    expect(await stored()).toEqual([]);
  });

  it("does not add an unnumbered account twice when run twice", async () => {
    // The unique index was over `(version_id, account_number, account_name)`
    // and the number is nullable — NULL is never equal to NULL, so the index
    // did not apply to unnumbered accounts at all. That is what a QuickBooks
    // export produces. See migration 0018.
    await addLedgerRow();
    await rebuild().expect(200);
    await rebuild().expect(200);
    await rebuild().expect(200);
    expect(await stored()).toHaveLength(1);
  });

  it("refuses a second unnumbered account with the same name, at the database", async () => {
    await addLedgerRow();
    await rebuild().expect(200);
    await expect(
      db.insert(schema.chartOfAccounts).values({
        versionId,
        companyId,
        accountName: "Office Rent",
      }),
    ).rejects.toThrow();
  });

  it("keeps two accounts that share a name but differ in number", async () => {
    await addLedgerRow({ accountName: "Rent", accountNumber: "6000" });
    await addLedgerRow({ accountName: "Rent", accountNumber: "6001" });
    await rebuild().expect(200);
    expect(await stored()).toHaveLength(2);
  });

  it("leaves a ledger's balance rows out of the chart", async () => {
    // They are rows ABOUT an account, not accounts. Excluded by `row_type`
    // rather than by matching the text.
    await addLedgerRow({ accountName: "Office Rent" });
    await addLedgerRow({ accountName: "Ending Balance", rowType: "ENDING_BALANCE" });
    await rebuild().expect(200);
    expect((await stored()).map((r) => r.accountName)).toEqual(["Office Rent"]);
  });

  it("keeps a row whose type is spelled in either case", async () => {
    // The column defaults to `TRANSACTION` in upper case and older writers
    // used lower. A case-sensitive exclusion list matches neither reliably.
    await addLedgerRow({ accountName: "Office Rent", rowType: "transaction" });
    await addLedgerRow({ accountName: "Wages", rowType: "TRANSACTION" });
    await addLedgerRow({ accountName: "Opening", rowType: "beginning_balance" });
    await rebuild().expect(200);
    expect((await stored()).map((r) => r.accountName).sort()).toEqual(["Office Rent", "Wages"]);
  });

  it("leaves an extractor's subtotal out of the chart", async () => {
    // Feeding one back in as an account double counts everything beneath it.
    await addPlRow({ accountName: "Office Rent" });
    await addPlRow({ accountName: "Marketing", isTotal: true });
    await rebuild().expect(200);
    expect((await stored()).map((r) => r.accountName)).toEqual(["Office Rent"]);
  });

  it("records the rules' own answer, so an edit can be undone", async () => {
    await addLedgerRow();
    await rebuild().expect(200);
    const [account] = await stored();
    expect(account!.originalName).toBe("Office Rent");
    expect(Array.isArray(account!.originalHierarchy)).toBe(true);
  });

  it("says how the type was decided", async () => {
    await addLedgerRow({ accountName: "Bank Charges & Fees", accountNumber: "6100" });
    await rebuild().expect(200);
    const [account] = await stored();
    // The number, not the name — `\bbank\b` would otherwise make this an asset.
    expect(account!.classificationMethod).toBe("account_number");
    expect(account!.accountType).toBe("expense");
  });

  it("keeps one version's chart off another's", async () => {
    const [other] = await db
      .insert(schema.keyReportVersions)
      .values({ companyId, versionNumber: 2 })
      .returning();
    await db.insert(schema.chartOfAccounts).values({
      versionId: other!.id,
      companyId,
      accountName: "Theirs",
    });
    await addLedgerRow();

    const res = await rebuild().expect(200);
    expect(res.body.removedCount).toBe(0);
    const theirs = await db
      .select()
      .from(schema.chartOfAccounts)
      .where(eq(schema.chartOfAccounts.versionId, other!.id));
    expect(theirs).toHaveLength(1);
  });

  it("403s a version the caller cannot reach", async () => {
    current = { ...current, company_ids: [] };
    await rebuild().expect(403);
  });

  it("404s a version that does not exist", async () => {
    await request(app)
      .post(`/key-reports/versions/${randomUUID()}/chart-of-accounts/regenerate`)
      .expect(404);
  });
});
