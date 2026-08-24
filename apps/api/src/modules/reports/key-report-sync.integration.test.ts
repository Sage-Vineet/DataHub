import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import { loadAnchors } from "../../shared/engagement.drizzle.js";
import {
  DrizzleStatementEntryWriter,
  DrizzleSyncLogWriter,
} from "./key-report-sync.drizzle.js";
import { flattenStatement } from "./statement-entries.js";

/**
 * The entry tables, against a real database.
 *
 * What matters here is not that the rows go in — it is that what goes in is
 * what `loadAnchors` reads back out. These two are the only writer and the
 * only reader of `balance_sheet_entries`, and a disagreement between them is
 * an engagement that loads with no accounts in it.
 */

const STATEMENT = [
  {
    name: "Assets",
    amount: 26000,
    children: [
      {
        name: "Bank Accounts",
        amount: 5000,
        children: [{ name: "1000 Operating Cash", amount: 5000, type: "asset" }],
      },
    ],
  },
  {
    name: "Liabilities",
    amount: 1500,
    children: [{ name: "2000 Bank Loan", amount: 1500, type: "liability" }],
  },
];

let client: PGlite;
let db: Db;
let companyId: string;
let versionId: string;
let userId: string;
let documentId: string;
let entries: DrizzleStatementEntryWriter;
let logs: DrizzleSyncLogWriter;

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;

  userId = randomUUID();
  companyId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    name: "Uma",
    email: `${userId}@x.test`,
    passwordHash: "!",
    role: "broker",
  });
  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });
  const [version] = await db
    .insert(schema.keyReportVersions)
    .values({ companyId, versionNumber: 1 })
    .returning();
  versionId = version!.id;

  // `source_file_id` is a foreign key to `documents`: an entry row has to name
  // a file somebody can open, which is what makes a figure checkable.
  documentId = await addDocument("Balance Sheet 2025.pdf");

  entries = new DrizzleStatementEntryWriter(db);
  logs = new DrizzleSyncLogWriter(db);
});

afterEach(async () => {
  await client.close();
});

/**
 * A document in its own folder.
 *
 * Its own, because a company may not have two folders of one name — so a
 * fixture that reuses the name can only ever create one document.
 */
async function addDocument(name: string): Promise<string> {
  const [folder] = await db
    .insert(schema.folders)
    .values({ companyId, name: `Financials ${name}`, createdBy: userId })
    .returning();
  const [document] = await db
    .insert(schema.documents)
    .values({
      companyId,
      folderId: folder!.id,
      name,
      fileUrl: `/uploads/${name}`,
      size: "1",
      ext: "pdf",
      status: "under-review" as never,
      uploadedBy: userId,
    })
    .returning();
  return document!.id;
}

const write = (over: Record<string, unknown> = {}) =>
  entries.replaceForDocument({
    versionId,
    companyId,
    documentId,
    kind: "balance_sheet",
    fiscalYear: 2025,
    asOfDate: "2025-12-31",
    rows: flattenStatement(STATEMENT, { kind: "balance_sheet" }),
    ...over,
  });

const storedBalanceSheet = () =>
  db.select().from(schema.balanceSheetEntries).where(eq(schema.balanceSheetEntries.versionId, versionId));

describe("writing a balance sheet", () => {
  it("stores every row the statement carried", async () => {
    // Five: two headings and three accounts, all kept — the headings are
    // marked as totals rather than dropped, so the page can render the
    // statement as it was written.
    expect(await write()).toBe(5);
    expect(await storedBalanceSheet()).toHaveLength(5);
  });

  it("writes rows `loadAnchors` reads back as accounts", async () => {
    // The only writer and the only reader of this table. A disagreement
    // between them is an engagement that loads with no accounts in it.
    await write();
    const anchors = await loadAnchors(db, versionId);

    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ fiscalYear: 2025, month: 12 });
    expect(anchors[0]!.rows.map((r) => r.accountName).sort()).toEqual([
      "Bank Loan",
      "Operating Cash",
    ]);
  });

  it("keeps the headings out of the roll, because they are totals", async () => {
    // "Assets" and "Bank Accounts" carry the sum of what sits under them.
    // Rolled as accounts they are counted against those accounts, and the
    // sheet still balances — it is just wrong by the size of every heading.
    await write();
    const names = (await loadAnchors(db, versionId))[0]!.rows.map((r) => r.accountName);
    expect(names).not.toContain("Assets");
    expect(names).not.toContain("Bank Accounts");
  });

  it("carries the section through to the anchor", async () => {
    await write();
    const rows = (await loadAnchors(db, versionId))[0]!.rows;
    expect(rows.find((r) => r.accountName === "Operating Cash")?.section).toBe("asset");
    expect(rows.find((r) => r.accountName === "Bank Loan")?.section).toBe("liability");
  });

  it("carries the amount as a number, not a string", async () => {
    // The column is `numeric`, which the driver hands back as a string. An
    // anchor holding "5000.00" adds up as string concatenation.
    await write();
    const cash = (await loadAnchors(db, versionId))[0]!.rows.find(
      (r) => r.accountName === "Operating Cash",
    );
    expect(cash?.amount).toBe(5000);
  });

  it("replaces that document's rows and no others", async () => {
    // Re-syncing one file must not empty the rest of the version.
    const other = await addDocument("Other.pdf");
    await write();
    await write({
      documentId: other,
      rows: flattenStatement([{ name: "Other", amount: 1 }], { kind: "balance_sheet" }),
    });
    await write();

    const stored = await storedBalanceSheet();
    expect(stored.filter((r) => r.sourceFileId === documentId)).toHaveLength(5);
    expect(stored.filter((r) => r.sourceFileId === other)).toHaveLength(1);
  });

  it("writes nothing, and removes what was there, for a statement with no rows", async () => {
    await write();
    expect(await write({ rows: [] })).toBe(0);
    expect(await storedBalanceSheet()).toEqual([]);
  });

  it("falls back to the year end when the caller resolved no date", async () => {
    // `as_of_date` is NOT NULL, and a position with no date anchors nothing.
    await write({ asOfDate: null });
    expect((await storedBalanceSheet())[0]?.asOfDate).toBe("2025-12-31");
  });
});

describe("clearing what this system generated", () => {
  it("removes generated rows and leaves extracted ones", async () => {
    // A carry-forward has to be recomputed from freshly extracted figures, or
    // it compounds whatever produced it.
    await write();
    await db.insert(schema.balanceSheetEntries).values({
      versionId,
      companyId,
      sourceFileId: documentId,
      asOfDate: "2024-12-31",
      fiscalYear: 2024,
      accountName: "Carried Forward",
      amount: "100.00",
      isGenerated: true,
    });

    expect(await entries.clearGenerated(versionId)).toBe(1);
    const stored = await storedBalanceSheet();
    expect(stored).toHaveLength(5);
    expect(stored.every((r) => r.isGenerated === false)).toBe(true);
  });

  it("leaves another version's generated rows alone", async () => {
    const [other] = await db
      .insert(schema.keyReportVersions)
      .values({ companyId, versionNumber: 2 })
      .returning();
    await db.insert(schema.balanceSheetEntries).values({
      versionId: other!.id,
      companyId,
      sourceFileId: documentId,
      asOfDate: "2024-12-31",
      fiscalYear: 2024,
      accountName: "Theirs",
      amount: "1.00",
      isGenerated: true,
    });

    expect(await entries.clearGenerated(versionId)).toBe(0);
  });
});

describe("writing a profit and loss", () => {
  it("stores it in its own table, with the heading as the category", async () => {
    // Two tables rather than one: a balance sheet states a position on a DATE
    // and carries a section, a P&L covers a YEAR and carries a category.
    await entries.replaceForDocument({
      versionId,
      companyId,
      documentId,
      kind: "profit_and_loss",
      fiscalYear: 2025,
      asOfDate: null,
      rows: flattenStatement(
        [{ name: "Income", amount: 1000, children: [{ name: "4000 Sales", amount: 1000 }] }],
        { kind: "profit_and_loss" },
      ),
    });

    const stored = await db
      .select()
      .from(schema.profitLossEntries)
      .where(eq(schema.profitLossEntries.versionId, versionId));

    expect(stored).toHaveLength(2);
    const sales = stored.find((r) => r.accountName === "Sales");
    expect(sales).toMatchObject({ accountNumber: "4000", category: "Income", fiscalYear: 2025 });
    expect(await storedBalanceSheet()).toEqual([]);
  });

  it("clears nothing on the P&L side, because it carries no generated rows", async () => {
    // `is_generated` exists on `balance_sheet_entries` alone: the carry-forward
    // that produces generated rows is a balance-sheet operation, and a period's
    // figures are that period's.
    expect(await entries.clearGenerated(versionId)).toBe(0);
  });
});

describe("the sync log", () => {
  it("opens one the database numbers itself", async () => {
    // The column has `DEFAULT nextval(...)`. Modelled without one, every
    // caller had to invent a primary key — the database's job, and a race.
    const id = await logs.start({ versionId, companyId, createdBy: userId });
    expect(typeof id).toBe("number");

    const [row] = await db
      .select()
      .from(schema.keyReportSyncLogs)
      .where(eq(schema.keyReportSyncLogs.id, id));
    expect(row).toMatchObject({ versionId, companyId, syncStatus: "started" });
  });

  it("numbers a second one differently", async () => {
    const first = await logs.start({ versionId, companyId, createdBy: userId });
    const second = await logs.start({ versionId, companyId, createdBy: null });
    expect(second).not.toBe(first);
  });

  it("closes one with what the run found", async () => {
    const id = await logs.start({ versionId, companyId, createdBy: userId });
    await logs.finish(id, { status: "success", metadata: { processed: 2, years: [2025] } });

    const [row] = await db
      .select()
      .from(schema.keyReportSyncLogs)
      .where(eq(schema.keyReportSyncLogs.id, id));
    expect(row).toMatchObject({ syncStatus: "success", errorMessage: null });
    expect(row?.metadata).toMatchObject({ processed: 2 });
    expect(row?.syncCompletedAt).toBeTruthy();
  });

  it("closes a failed one with its reason", async () => {
    const id = await logs.start({ versionId, companyId, createdBy: userId });
    await logs.finish(id, {
      status: "failed",
      errorMessage: "No statement could be read (2 failed).",
      metadata: {},
    });

    const [row] = await db
      .select()
      .from(schema.keyReportSyncLogs)
      .where(
        and(
          eq(schema.keyReportSyncLogs.id, id),
          eq(schema.keyReportSyncLogs.syncStatus, "failed"),
        ),
      );
    expect(row?.errorMessage).toMatch(/No statement could be read/);
  });
});
