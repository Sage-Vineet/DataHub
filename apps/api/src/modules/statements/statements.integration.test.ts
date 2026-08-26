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
let repo: DrizzleStatementsRepository;

/**
 * A model that reads every document as the same balance sheet.
 *
 * What is under test here is the plumbing — which documents are found, what is
 * stored against them, what the run says — not the extraction, which has its
 * own tests over a fake.
 */
const reader = {
  ask: () => Promise.reject(new Error("not used")),
  askForJson: <T,>(): Promise<T> =>
    Promise.resolve({
      asOfDate: "2025-12-31",
      rows: [{ name: "Total Assets", amount: 100_000 }],
    } as T),
};

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
  const module = createStatementsModule({ db, requireAuth, reader });
  app.use("/", module.router);
  service = module.service;
  repo = new DrizzleStatementsRepository(db);
});

afterEach(async () => {
  await client.close();
});

async function addDocument(name: string): Promise<string> {
  // With the bytes behind it: a document whose upload is missing is a document
  // extraction cannot read, and every sync test would fail on that rather than
  // on what it is about.
  const [upload] = await db
    .insert(schema.uploads)
    .values({
      fileName: name,
      contentType: "application/pdf",
      sizeBytes: 6,
      data: Buffer.from("a file"),
      uploadedBy: BROKER.id,
    })
    .returning();

  const [document] = await db
    .insert(schema.documents)
    .values({
      name,
      companyId,
      folderId,
      uploadId: upload!.id,
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
    provenance: { from: "document", documentId },
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

  it("offers only the version's files in the picker, not the whole history", async () => {
    // The picker has to agree with what the page is showing. `latest` already
    // resolves through the version; a list that ignored it would offer a file
    // the version was never signed off against, and picking it would show
    // figures nobody approved with nothing on screen saying so.
    const linked = await addDocument("BS 2023.pdf");
    const unlinked = await addDocument("BS 2024.pdf");
    await save(linked, { asOfDate: "2023-12-31" });
    await save(unlinked, { asOfDate: "2024-12-31" });

    const [version] = await db
      .insert(schema.keyReportVersions)
      .values({ companyId, versionNumber: 1 })
      .returning();
    await db.insert(schema.keyReportFileMappings).values({
      versionId: version!.id,
      companyId,
      reportCategory: "balance_sheet",
      documentId: linked,
    });

    const res = await request(app)
      .get(`/manual-report-uploads/reports/balance_sheet/all?keyReportVersionId=${version!.id}`)
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.files.map((f: { fileName: string }) => f.fileName)).toEqual(["BS 2023.pdf"]);
  });

  it("offers nothing for a version that links nothing", async () => {
    // Not "everything". A version with no balance sheet linked has no balance
    // sheet, and filling the picker with the company's other files invites
    // somebody to pick one and believe the version contains it.
    const documentId = await addDocument("BS 2024.pdf");
    await save(documentId);
    const [version] = await db
      .insert(schema.keyReportVersions)
      .values({ companyId, versionNumber: 2 })
      .returning();

    const res = await request(app)
      .get(`/manual-report-uploads/reports/balance_sheet/all?keyReportVersionId=${version!.id}`)
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.files).toEqual([]);
  });

  it("names the folder a file came from", async () => {
    // The picker shows the file name; two folders can hold a "Balance
    // Sheet.pdf" each, and the folder is the only thing that tells them apart.
    const documentId = await addDocument("BS 2024.pdf");
    await save(documentId);
    const res = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.files[0].folderName).toBe("Financials");
  });

  it("keeps the two manual sources apart on their own routes", async () => {
    // The page has one picker per source. A QMS route that answered with a
    // spreadsheet's figures would put them on the QuickBooks tab, where
    // nothing on screen says they are from a different source.
    const spreadsheet = await addDocument("Uploaded BS.xlsx");
    const quickbooks = await addDocument("QMS BS.pdf");
    await save(spreadsheet);
    await save(quickbooks, { sourceKey: "quickbooks_manual" });

    const qms = await request(app)
      .get("/manual-report-uploads/qms-reports/balance_sheet/all")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(qms.body.files.map((f: { fileName: string }) => f.fileName)).toEqual(["QMS BS.pdf"]);

    const manual = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(manual.body.files.map((f: { fileName: string }) => f.fileName)).toEqual([
      "Uploaded BS.xlsx",
    ]);
  });

  it("resolves the latest QMS statement without being told the source", async () => {
    const spreadsheet = await addDocument("Uploaded BS.xlsx");
    const quickbooks = await addDocument("QMS BS.pdf");
    await save(quickbooks, { sourceKey: "quickbooks_manual" });
    await save(spreadsheet);

    const res = await request(app)
      .get("/manual-report-uploads/qms-reports/balance_sheet/latest")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.documentName).toBe("QMS BS.pdf");
  });

  it("builds a QMS source tree holding only QMS documents", async () => {
    const spreadsheet = await addDocument("Uploaded BS.xlsx");
    const quickbooks = await addDocument("QMS BS.pdf");
    await save(spreadsheet);
    await save(quickbooks, { sourceKey: "quickbooks_manual" });

    const res = await request(app)
      .get("/manual-report-uploads/qms-source-tree")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.tree.map((e: { documentName: string }) => e.documentName)).toEqual([
      "QMS BS.pdf",
    ]);
  });

  it("derives a cash flow from statements already on file", async () => {
    // Legacy served these from a cache written during "Sync All", so a company
    // with every input uploaded still got "Run Sync All to generate cash flow
    // reports automatically" until somebody did. Nothing is cached here.
    const bs2023 = await addDocument("BS 2023.pdf");
    const bs2024 = await addDocument("BS 2024.pdf");
    const pl2024 = await addDocument("PL 2024.pdf");
    await save(bs2023, { asOfDate: "2023-12-31", payload: { rows: [{ name: "Cash", amount: 100 }] } });
    await save(bs2024, { asOfDate: "2024-12-31", payload: { rows: [{ name: "Cash", amount: 150 }] } });
    await service.save(current, companyId, {
      provenance: { from: "document", documentId: pl2024 },
      statementType: "profit_and_loss",
      periodStart: "2024-01-01",
      periodEnd: "2024-12-31",
      payload: { rows: [{ name: "Net Income", amount: 50 }] },
    });

    const res = await request(app)
      .get("/manual-upload/cashflow?period=2024")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.beginningCash).toBe(100);
    expect(res.body.endingCash).toBe(150);
    expect(res.body.cashValidated).toBe(true);
  });

  it("names the file that is missing rather than telling somebody to sync", async () => {
    // The person reading this is the person who can fix it by uploading that
    // file. Legacy's message pointed them at a sync that would not have helped.
    const bs2024 = await addDocument("BS 2024.pdf");
    await save(bs2024, { asOfDate: "2024-12-31" });

    const res = await request(app)
      .get("/manual-upload/cashflow?period=2024")
      .set("X-Client-Id", companyId)
      .expect(404);
    expect(res.body.missingInputs).toEqual(["Profit and Loss 2024"]);
    expect(res.body.fiscalYear).toBe(2024);
  });

  it("refuses a period that is not a year rather than guessing one", async () => {
    await request(app)
      .get("/manual-upload/cashflow?period=last%20year")
      .set("X-Client-Id", companyId)
      .expect(400);
    await request(app)
      .get("/manual-upload/cashflow")
      .set("X-Client-Id", companyId)
      .expect(400);
  });

  it("offers the years that have both inputs, not the years somebody cached", async () => {
    const bs2023 = await addDocument("BS 2023.pdf");
    const bs2024 = await addDocument("BS 2024.pdf");
    const pl2024 = await addDocument("PL 2024.pdf");
    await save(bs2023, { asOfDate: "2023-12-31" });
    await save(bs2024, { asOfDate: "2024-12-31" });
    await service.save(current, companyId, {
      provenance: { from: "document", documentId: pl2024 },
      statementType: "profit_and_loss",
      periodEnd: "2024-12-31",
      payload: { rows: [] },
    });

    const res = await request(app)
      .get("/manual-upload/cashflow/periods")
      .set("X-Client-Id", companyId)
      .expect(200);
    // 2023 has a balance sheet but no P&L, so no cash flow can be built for it.
    expect(res.body.periods).toEqual([{ fiscalYear: 2024, hasPriorBalanceSheet: true }]);
  });

  it("says when a year has no prior balance sheet to measure against", async () => {
    // Without one every movement is measured against nothing, so the statement
    // shows the P&L's addbacks and no working capital at all. Worth saying on
    // the picker rather than letting somebody wonder why a year looks empty.
    const bs = await addDocument("BS 2024.pdf");
    const pl = await addDocument("PL 2024.pdf");
    await save(bs, { asOfDate: "2024-12-31" });
    await service.save(current, companyId, {
      provenance: { from: "document", documentId: pl },
      statementType: "profit_and_loss",
      periodEnd: "2024-12-31",
      payload: { rows: [] },
    });

    const res = await request(app)
      .get("/manual-upload/cashflow/periods")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.periods).toEqual([{ fiscalYear: 2024, hasPriorBalanceSheet: false }]);
  });

  it("keeps one source's cash flow off another source's page", async () => {
    const bs = await addDocument("QMS BS 2024.pdf");
    const pl = await addDocument("QMS PL 2024.pdf");
    await save(bs, { asOfDate: "2024-12-31", sourceKey: "quickbooks_manual" });
    await service.save(current, companyId, {
      provenance: { from: "document", documentId: pl },
      statementType: "profit_and_loss",
      sourceKey: "quickbooks_manual",
      periodEnd: "2024-12-31",
      payload: { rows: [] },
    });

    const manual = await request(app)
      .get("/manual-upload/cashflow/periods")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(manual.body.periods).toEqual([]);

    const qms = await request(app)
      .get("/manual-upload/cashflow/periods?sourceKey=quickbooks_manual")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(qms.body.periods).toHaveLength(1);
  });

  it("403s a company the caller cannot reach", async () => {
    await request(app)
      .get("/manual-upload/cashflow/periods")
      .set("X-Client-Id", "11111111-1111-4111-8111-111111111111")
      .expect(403);
  });

  it("keeps two pulls of one period on different bases as two rows", async () => {
    // Against the real unique index, not the fake. Without the variant in the
    // pull key both share one key and the second REPLACES the first, so the
    // page shows whichever basis was fetched most recently and nothing on
    // screen says which — the two reports have the same shape, the same
    // accounts and different numbers.
    const [run] = await db
      .insert(schema.syncRuns)
      .values({ companyId, sourceKey: "quickbooks", status: "running" })
      .returning();

    const pull = (variant: string) =>
      service.save(current, companyId, {
        provenance: {
          from: "pull",
          syncRunId: run!.id,
          reportParams: { accounting_method: variant },
          variant,
        },
        statementType: "balance_sheet",
        sourceKey: "quickbooks",
        periodStart: "2024-01-01",
        periodEnd: "2024-12-31",
        payload: { Header: { ReportBasis: variant } },
      });

    await pull("Accrual");
    await pull("Cash");

    const held = await db.select().from(schema.statementExtracts);
    expect(held).toHaveLength(2);
  });

  it("still replaces when the same basis is pulled again", async () => {
    const [run] = await db
      .insert(schema.syncRuns)
      .values({ companyId, sourceKey: "quickbooks", status: "running" })
      .returning();

    const pull = (rows: number) =>
      service.save(current, companyId, {
        provenance: { from: "pull", syncRunId: run!.id, variant: "Accrual" },
        statementType: "balance_sheet",
        sourceKey: "quickbooks",
        periodStart: "2024-01-01",
        periodEnd: "2024-12-31",
        payload: { rows },
      });

    await pull(1);
    await pull(2);

    const held = await db.select().from(schema.statementExtracts);
    expect(held).toHaveLength(1);
    expect(held[0]!.payload).toEqual({ rows: 2 });
  });

  it("stores a pull that belongs to no run at all", async () => {
    // An on-demand fetch: somebody asked for a period no sync had covered.
    // The provenance CHECK used to demand a run, which would have meant a
    // `sync_runs` row per page load. See migration 0015.
    const saved = await service.save(current, companyId, {
      provenance: { from: "pull", reportParams: { start_date: "2024-01-01" }, variant: "Cash" },
      statementType: "profit_and_loss",
      sourceKey: "quickbooks",
      periodStart: "2024-01-01",
      periodEnd: "2024-12-31",
      payload: { Header: {} },
    });
    expect(saved.syncRunId).toBeNull();
    expect(saved.documentId).toBeNull();
  });

  it("accepts the two report types that are not statements", async () => {
    // A general ledger and an account list are what QuickBooks answers when
    // asked, and the CHECK admitted only the five financial statements. See
    // migration 0014 for why they live here rather than in a fourteenth table.
    for (const statementType of ["general_ledger", "account_list"] as const) {
      const saved = await service.save(current, companyId, {
        provenance: { from: "pull", variant: null },
        statementType,
        sourceKey: "quickbooks",
        periodStart: null,
        periodEnd: null,
        payload: { Rows: {} },
      });
      expect(saved.statementType).toBe(statementType);
    }
  });

  it("builds a dashboard with a card per year", async () => {
    const bs2023 = await addDocument("BS 2023.pdf");
    const bs2024 = await addDocument("BS 2024.pdf");
    const pl2024 = await addDocument("PL 2024.pdf");

    const rows = (revenue: number) => ({
      rows: [
        { name: "Total Income", amount: revenue },
        { name: "Total Expenses", amount: 80 },
        { name: "Net Income", amount: revenue - 80 },
      ],
    });

    await save(bs2023, { asOfDate: "2023-12-31", payload: { rows: [{ name: "Total Assets", amount: 900 }] } });
    await save(bs2024, { asOfDate: "2024-12-31", payload: { rows: [{ name: "Total Assets", amount: 1000 }] } });
    await service.save(current, companyId, {
      provenance: { from: "document", documentId: pl2024 },
      statementType: "profit_and_loss",
      periodEnd: "2024-12-31",
      payload: rows(500),
    });

    const res = await request(app)
      .get("/manual-report-uploads/manual-upload-dashboard")
      .set("X-Client-Id", companyId)
      .expect(200);

    expect(res.body.years).toEqual(["All Files", "2024", "2023"]);
    expect(res.body.reports["2024"].kpis.totalAssets).toBe(1000);
    expect(res.body.reports["2024"].kpis.totalRevenue).toBe(500);
    expect(res.body.reports["2024"].balanceSheet.fileName).toBe("BS 2024.pdf");
  });

  it("names what is missing for a year rather than counting it", () => {
    // "Balance Sheet missing for 2023" tells somebody which file to upload;
    // "2 warnings" does not.
    return (async () => {
      const bs = await addDocument("BS 2023.pdf");
      await save(bs, { asOfDate: "2023-12-31" });

      const res = await request(app)
        .get("/manual-report-uploads/manual-upload-dashboard")
        .set("X-Client-Id", companyId)
        .expect(200);
      expect(res.body.reports["2023"].warnings).toEqual(["Profit & Loss missing for 2023"]);
    })();
  });

  it("draws the trend oldest first", async () => {
    for (const year of [2022, 2024, 2023]) {
      const doc = await addDocument(`PL ${year}.pdf`);
      await service.save(current, companyId, {
        provenance: { from: "document", documentId: doc },
        statementType: "profit_and_loss",
        periodEnd: `${year}-12-31`,
        payload: { rows: [{ name: "Total Income", amount: year }] },
      });
    }

    const res = await request(app)
      .get("/manual-report-uploads/manual-upload-dashboard")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.trends.map((t: { year: string }) => t.year)).toEqual(["2022", "2023", "2024"]);
  });

  it("uses the most recently extracted statement when a year has several", async () => {
    // A corrected re-upload should win over the file it corrects, and
    // extraction time is the only ordering that says so — the period is the
    // same for both.
    const first = await addDocument("BS 2024 v1.pdf");
    const second = await addDocument("BS 2024 v2.pdf");
    await save(first, { asOfDate: "2024-12-31", payload: { rows: [{ name: "Total Assets", amount: 1 }] } });
    await save(second, { asOfDate: "2024-12-31", payload: { rows: [{ name: "Total Assets", amount: 2 }] } });

    const res = await request(app)
      .get("/manual-report-uploads/manual-upload-dashboard")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.reports["2024"].kpis.totalAssets).toBe(2);
    expect(res.body.reports["2024"].balanceSheet.fileName).toBe("BS 2024 v2.pdf");
  });

  it("keeps one source's dashboard off another's", async () => {
    const manual = await addDocument("Manual BS.pdf");
    const qms = await addDocument("QMS BS.pdf");
    await save(manual, { asOfDate: "2024-12-31", payload: { rows: [{ name: "Total Assets", amount: 111 }] } });
    await save(qms, {
      asOfDate: "2024-12-31",
      sourceKey: "quickbooks_manual",
      payload: { rows: [{ name: "Total Assets", amount: 999 }] },
    });

    const manualRes = await request(app)
      .get("/manual-report-uploads/manual-upload-dashboard")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(manualRes.body.reports["2024"].kpis.totalAssets).toBe(111);

    const qmsRes = await request(app)
      .get("/manual-report-uploads/qms-dashboard?source=quickbooks_manual")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(qmsRes.body.reports["2024"].kpis.totalAssets).toBe(999);
  });

  it("refuses a source that is not this dashboard's", async () => {
    // The page sends which dashboard it thinks it is showing. Serving one
    // source's figures under another's heading is what this catches.
    await request(app)
      .get("/manual-report-uploads/qms-dashboard?source=manual_upload")
      .set("X-Client-Id", companyId)
      .expect(400);
  });

  it("shows a company with nothing uploaded an empty dashboard", async () => {
    const res = await request(app)
      .get("/manual-report-uploads/manual-upload-dashboard")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.years).toEqual(["All Files"]);
    expect(res.body.allFiles.warnings).toEqual([
      "No Balance Sheet files found",
      "No Profit & Loss files found",
    ]);
  });

  it("403s a company the caller cannot reach", async () => {
    await request(app)
      .get("/manual-report-uploads/manual-upload-dashboard")
      .set("X-Client-Id", "11111111-1111-4111-8111-111111111111")
      .expect(403);
  });

  it("builds the books' side of the tax reconciliation, per year", async () => {
    const pl2023 = await addDocument("PL 2023.pdf");
    const pl2024 = await addDocument("PL 2024.pdf");
    const rows = (revenue: number) => ({
      rows: [
        { name: "Total Income", amount: revenue },
        { name: "Total Expenses", amount: 300000 },
        { name: "Officer Compensation", amount: 150000 },
        { name: "Net Income", amount: revenue - 300000 },
      ],
    });

    for (const [doc, year, revenue] of [
      [pl2023, "2023", 800000],
      [pl2024, "2024", 1000000],
    ] as const) {
      await service.save(current, companyId, {
        provenance: { from: "document", documentId: doc },
        statementType: "profit_and_loss",
        periodEnd: `${year}-12-31`,
        payload: rows(revenue),
      });
    }

    const res = await request(app)
      .get("/manual-report-uploads/pl-for-tax")
      .set("X-Client-Id", companyId)
      .expect(200);

    expect(Object.keys(res.body.years).sort()).toEqual(["2023", "2024"]);
    expect(res.body.years["2024"].totalRevenue).toBe(1000000);
    expect(res.body.years["2024"].officerWages).toBe(150000);
    // 300000 − (150000 + 0 + 0 + 0)
    expect(res.body.years["2024"].allOtherExpenses).toBe(150000);
    expect(res.body.years["2024"].fileName).toBe("PL 2024.pdf");
  });

  it("skips a statement with no rows rather than filing an empty year", async () => {
    // Filing it would hide whichever statement for that year does have rows.
    const empty = await addDocument("PL 2024 empty.pdf");
    const real = await addDocument("PL 2024.pdf");
    await service.save(current, companyId, {
      provenance: { from: "document", documentId: empty },
      statementType: "profit_and_loss",
      periodEnd: "2024-12-31",
      payload: { rows: [] },
    });
    await service.save(current, companyId, {
      provenance: { from: "document", documentId: real },
      statementType: "profit_and_loss",
      periodEnd: "2024-12-31",
      payload: { rows: [{ name: "Total Income", amount: 5 }] },
    });

    const res = await request(app)
      .get("/manual-report-uploads/pl-for-tax")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.years["2024"].totalRevenue).toBe(5);
  });

  it("keeps one source's figures off another's", async () => {
    const manual = await addDocument("Manual PL.pdf");
    const qms = await addDocument("QMS PL.pdf");
    for (const [doc, sourceKey, revenue] of [
      [manual, "manual_upload_excel_pdf", 111],
      [qms, "quickbooks_manual", 999],
    ] as const) {
      await service.save(current, companyId, {
        provenance: { from: "document", documentId: doc },
        statementType: "profit_and_loss",
        sourceKey,
        periodEnd: "2024-12-31",
        payload: { rows: [{ name: "Total Income", amount: revenue }] },
      });
    }

    const res = await request(app)
      .get("/manual-report-uploads/pl-for-tax")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.years["2024"].totalRevenue).toBe(111);
  });

  it("403s a company the caller cannot reach", async () => {
    await request(app)
      .get("/manual-report-uploads/pl-for-tax")
      .set("X-Client-Id", "11111111-1111-4111-8111-111111111111")
      .expect(403);
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
    expect(all.body.files.map((r: { fileName: string }) => r.fileName)).toEqual([
      "BS 2024.pdf",
      "BS 2023.pdf",
    ]);

    const only2023 = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all?fiscalYear=2023")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(only2023.body.files).toHaveLength(1);
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

/**
 * Statements that came from an API pull rather than a file.
 *
 * `report_snapshots` and `reporting_snapshots` were two more absent tables
 * holding this same thing. The only real difference from a file-sourced
 * statement is provenance, so they share a table — and these tests are about
 * the two places that difference actually shows: the identity of a row, and
 * what the source tree is a picture of.
 */
describe("pulled statements (real Postgres)", () => {
  /**
   * A completed pull.
   *
   * The run is finished before the next one starts, because `sync_runs` permits
   * exactly one unfinished run per company and source — a real pull finishes,
   * and a helper that left them open would be testing against a state the
   * system does not reach.
   */
  const pull = async (over: Record<string, unknown> = {}) => {
    const [run] = await db
      .insert(schema.syncRuns)
      .values({
        companyId,
        sourceKey: "quickbooks_online",
        status: "completed",
        finishedAt: new Date(),
      })
      .returning();
    return service.save(current, companyId, {
      provenance: { from: "pull", syncRunId: run!.id, reportParams: { accountingMethod: "Accrual" } },
      statementType: "balance_sheet",
      sourceKey: "quickbooks_online",
      periodStart: "2024-01-01",
      periodEnd: "2024-12-31",
      payload: { rows: [{ name: "Cash", amount: 500 }] },
      ...over,
    });
  };

  it("stores one with no document, and names the run instead", async () => {
    const saved = await pull();
    expect(saved.documentId).toBeNull();
    expect(saved.syncRunId).not.toBeNull();
    expect(saved.reportParams).toEqual({ accountingMethod: "Accrual" });
  });

  it("replaces when the same period is pulled again", async () => {
    // Pulling January twice is the same statement.
    await pull({ payload: { rows: [] } });
    await pull({ payload: { rows: [{ name: "Cash", amount: 999 }] } });

    const rows = await db.select().from(schema.statementExtracts);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as { rows: unknown[] }).rows).toEqual([
      { name: "Cash", amount: 999 },
    ]);
  });

  it("keeps a different period as a different statement", async () => {
    // Pulling January and February is two.
    await pull();
    await pull({ periodStart: "2023-01-01", periodEnd: "2023-12-31" });
    expect(await db.select().from(schema.statementExtracts)).toHaveLength(2);
  });

  it("refuses a row with no provenance at all", async () => {
    // A statement whose origin cannot be named is a number nobody can check.
    await expect(
      db.insert(schema.statementExtracts).values({
        companyId,
        statementType: "balance_sheet",
        payload: {},
      }),
    ).rejects.toThrow();
  });

  it("refuses a pulled row with no pull key", async () => {
    // A pull that lost its key would silently append a row per sync.
    const [run] = await db
      .insert(schema.syncRuns)
      .values({ companyId, sourceKey: "quickbooks_online", status: "running" })
      .returning();
    await expect(
      db.insert(schema.statementExtracts).values({
        companyId,
        syncRunId: run!.id,
        statementType: "balance_sheet",
        payload: {},
      }),
    ).rejects.toThrow();
  });

  it("serves it over HTTP alongside file-sourced ones", async () => {
    await pull();
    const res = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/latest?sourceKey=quickbooks_online")
      .set("X-Client-Id", companyId)
      .expect(200);

    expect(res.body.data).toEqual({ rows: [{ name: "Cash", amount: 500 }] });
    expect(res.body.documentId).toBeNull();
    expect(res.body.syncRunId).not.toBeNull();
  });

  it("stays out of the source tree, which is a picture of uploaded files", async () => {
    const documentId = await addDocument("BS 2024.pdf");
    await save(documentId);
    await pull();

    const res = await request(app)
      .get("/manual-report-uploads/source-tree")
      .set("X-Client-Id", companyId)
      .expect(200);
    // One entry, for the file. The pull has no document to sit under, and
    // inventing one would put a file on screen that does not exist.
    expect(res.body.tree).toHaveLength(1);
    expect(res.body.tree[0].documentName).toBe("BS 2024.pdf");
  });

  it("does not collide with a file-sourced statement of the same type", async () => {
    const documentId = await addDocument("BS 2024.pdf");
    await save(documentId);
    await pull();
    expect(await db.select().from(schema.statementExtracts)).toHaveLength(2);
  });
});

/**
 * The saved bank reconciliation.
 *
 * Legacy's twelfth absent table, `qb_bank_reconciliation_snapshots`: one row
 * per company holding a payload, a date range and an accounting method. That
 * is a statement with a period and a provenance, so it is one of these.
 */
describe("the saved bank reconciliation (real Postgres)", () => {
  const saved = () =>
    request(app).get("/qb-bank-activity/saved").set("X-Client-Id", companyId);

  const record = async (over: Record<string, unknown> = {}) => {
    const [run] = await db
      .insert(schema.syncRuns)
      .values({
        companyId,
        sourceKey: "quickbooks_online",
        status: "completed",
        finishedAt: new Date(),
      })
      .returning();
    return service.save(current, companyId, {
      provenance: {
        from: "pull",
        syncRunId: run!.id,
        reportParams: { accountingMethod: "Cash" },
      },
      statementType: "bank_reconciliation",
      sourceKey: "quickbooks_online",
      periodStart: "2024-01-01",
      periodEnd: "2024-03-31",
      payload: { accounts: [{ name: "Operating", cleared: 5000 }] },
      ...over,
    });
  };

  it("answers the PULLED reconciliation, not an uploaded statement", async () => {
    // Both are `bank_reconciliation` extracts. The uploaded ones are one per
    // document and hold `{ statements: [...] }`; the page here wants the
    // QuickBooks ladder and reads `data.accounts`. Handed the wrong one it
    // renders an empty grid with nothing to say why — so this saves the pull
    // FIRST and the document extract second, and still expects the pull.
    await record();
    const documentId = await addDocument("January.pdf");
    await service.save(current, companyId, {
      provenance: { from: "document", documentId },
      statementType: "bank_reconciliation",
      sourceKey: "manual_upload_excel_pdf",
      periodStart: "2024-05-01",
      periodEnd: "2024-05-31",
      payload: { statements: [{ bankName: "Wells Fargo" }] },
    });

    const res = await saved().expect(200);
    expect(res.body.data).toEqual({ accounts: [{ name: "Operating", cleared: 5000 }] });
    expect(res.body.startDate).toBe("2024-01-01");
  });

  it("says so plainly when nothing has been saved", async () => {
    // The page calls this on load to restore what it can WITHOUT a live
    // QuickBooks connection. A 404 there reads as an error rather than as
    // "nothing saved yet".
    const res = await saved().expect(200);
    expect(res.body).toEqual({ found: false });
  });

  it("serves the payload with its range and method", async () => {
    await record();
    const res = await saved().expect(200);

    expect(res.body.found).toBe(true);
    expect(res.body.startDate).toBe("2024-01-01");
    expect(res.body.endDate).toBe("2024-03-31");
    expect(res.body.accountingMethod).toBe("Cash");
    expect(res.body.data).toEqual({ accounts: [{ name: "Operating", cleared: 5000 }] });
  });

  it("defaults the accounting method rather than answering undefined", async () => {
    // The page renders it as a label beside the figures. `undefined` shows as
    // blank, and a reconciliation whose basis cannot be known is worse than
    // one labelled with the commoner of the two.
    const [run] = await db
      .insert(schema.syncRuns)
      .values({
        companyId,
        sourceKey: "quickbooks_online",
        status: "completed",
        finishedAt: new Date(),
      })
      .returning();
    await service.save(current, companyId, {
      // No `reportParams`, which is what a pull that never recorded one looks
      // like.
      provenance: { from: "pull", syncRunId: run!.id },
      statementType: "bank_reconciliation",
      sourceKey: "quickbooks_online",
      periodStart: "2024-01-01",
      periodEnd: "2024-03-31",
      payload: {},
    });

    const res = await saved().expect(200);
    expect(res.body.accountingMethod).toBe("Accrual");
  });

  it("replaces rather than accumulating when the same range is fetched again", async () => {
    await record({ payload: { accounts: [] } });
    await record({ payload: { accounts: [{ name: "Operating", cleared: 9999 }] } });

    const rows = await db
      .select()
      .from(schema.statementExtracts);
    expect(rows.filter((r) => r.statementType === "bank_reconciliation")).toHaveLength(1);

    const res = await saved().expect(200);
    expect(res.body.data).toEqual({ accounts: [{ name: "Operating", cleared: 9999 }] });
  });

  it("403s a company the caller cannot reach", async () => {
    await record();
    current = { ...BROKER, company_ids: [] };
    await saved().expect(403);
  });
});

describe("syncing a source into statements (real Postgres)", () => {
  /** Link a document to a version under a category, as the page does. */
  const linkDocument = async (
    documentId: string,
    category: string,
    versionId: string,
  ): Promise<void> => {
    await db.insert(schema.keyReportFileMappings).values({
      versionId,
      companyId,
      reportCategory: category,
      documentId,
      fileName: "linked.pdf",
    });
  };

  let versionNumber = 0;
  const addVersion = async (): Promise<string> => {
    const [version] = await db
      .insert(schema.keyReportVersions)
      .values({ companyId, versionNumber: (versionNumber += 1) })
      .returning();
    return version!.id;
  };

  it("reads every linked document and files it under the source", async () => {
    const versionId = await addVersion();
    const balanceSheet = await addDocument("Balance Sheet 2025.pdf");
    const profitLoss = await addDocument("Profit and Loss 2025.pdf");
    await linkDocument(balanceSheet, "balance_sheet", versionId);
    await linkDocument(profitLoss, "profit_loss", versionId);

    const res = await request(app)
      .post("/manual-report-uploads/sync-source")
      .set("X-Client-Id", companyId)
      .send({})
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.processed).toHaveLength(2);
    expect(res.body.failed).toEqual([]);

    const stored = await repo.latest(companyId, "balance_sheet", {
      sourceKey: "manual_upload_excel_pdf",
    });
    expect(stored?.documentId).toBe(balanceSheet);
    expect(stored?.fiscalYear).toBe(2025);
    expect(stored?.payload).toEqual({ rows: [{ name: "Total Assets", amount: 100_000 }] });
  });

  it("gives the dashboard something to show, which is the point of it", async () => {
    // Until this runs, a company that uploaded a year of statements sees an
    // empty dashboard with nothing to explain it.
    const versionId = await addVersion();
    await linkDocument(await addDocument("Balance Sheet 2025.pdf"), "balance_sheet", versionId);

    const before = await request(app)
      .get("/manual-report-uploads/manual-upload-dashboard")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(before.body.years).toEqual(["All Files"]);

    await request(app)
      .post("/manual-report-uploads/sync-source")
      .set("X-Client-Id", companyId)
      .send({})
      .expect(200);

    const after = await request(app)
      .get("/manual-report-uploads/manual-upload-dashboard")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(after.body.years).toEqual(["All Files", "2025"]);
  });

  it("files a QMS sync under the QMS source, not the manual one", async () => {
    const versionId = await addVersion();
    await linkDocument(await addDocument("QMS Balance Sheet.pdf"), "balance_sheet", versionId);

    await request(app)
      .post("/manual-report-uploads/sync-qms-source")
      .set("X-Client-Id", companyId)
      .send({})
      .expect(200);

    expect(
      await repo.latest(companyId, "balance_sheet", { sourceKey: "quickbooks_manual" }),
    ).not.toBeNull();
    expect(
      await repo.latest(companyId, "balance_sheet", { sourceKey: "manual_upload_excel_pdf" }),
    ).toBeNull();
  });

  it("reads a document linked to two versions once", async () => {
    const documentId = await addDocument("Balance Sheet 2025.pdf");
    await linkDocument(documentId, "balance_sheet", await addVersion());
    await linkDocument(documentId, "balance_sheet", await addVersion());

    const res = await request(app)
      .post("/manual-report-uploads/sync-source")
      .set("X-Client-Id", companyId)
      .send({})
      .expect(200);
    expect(res.body.processed).toHaveLength(1);
  });

  it("parses only the documents it was given", async () => {
    const versionId = await addVersion();
    await linkDocument(await addDocument("Ignore me.pdf"), "balance_sheet", versionId);
    const chosen = await addDocument("Chosen.pdf");

    const res = await request(app)
      .post("/manual-report-uploads/qms-parse-documents")
      .set("X-Client-Id", companyId)
      .send({ documents: [{ documentId: chosen, statementType: "profit_and_loss" }] })
      .expect(200);

    expect(res.body.processed).toHaveLength(1);
    expect(res.body.processed[0].documentId).toBe(chosen);
  });

  it("400s a parse with no documents", async () => {
    await request(app)
      .post("/manual-report-uploads/qms-parse-documents")
      .set("X-Client-Id", companyId)
      .send({})
      .expect(400);
  });

  it("refuses a second sync of the same source while one is running", async () => {
    const versionId = await addVersion();
    await linkDocument(await addDocument("Balance Sheet.pdf"), "balance_sheet", versionId);
    await db.insert(schema.syncRuns).values({
      companyId,
      sourceKey: "manual_upload_excel_pdf",
      kind: "documents",
      status: "running",
      totalFiles: 1,
      heartbeatAt: new Date(),
    });

    await request(app)
      .post("/manual-report-uploads/sync-source")
      .set("X-Client-Id", companyId)
      .send({})
      .expect(409);
  });

  it("does not read another company's linked documents", async () => {
    // The mapping carries a company and so does the document. Both are
    // demanded, because a mismatch between them is the shape a cross-company
    // read takes.
    const otherCompany = randomUUID();
    await db.insert(schema.companies).values({ id: otherCompany, name: "Beta", industry: "" });
    const [otherVersion] = await db
      .insert(schema.keyReportVersions)
      .values({ companyId: otherCompany, versionNumber: 1 })
      .returning();
    const [otherFolder] = await db
      .insert(schema.folders)
      .values({ companyId: otherCompany, name: "Financials", createdBy: BROKER.id })
      .returning();
    const [otherDocument] = await db
      .insert(schema.documents)
      .values({
        name: "Theirs.pdf",
        companyId: otherCompany,
        folderId: otherFolder!.id,
        fileUrl: "/uploads/theirs.pdf",
        size: "1",
        ext: "pdf",
        status: "under-review" as never,
        uploadedBy: BROKER.id,
      })
      .returning();
    await db.insert(schema.keyReportFileMappings).values({
      versionId: otherVersion!.id,
      companyId: otherCompany,
      reportCategory: "balance_sheet",
      documentId: otherDocument!.id,
    });

    const res = await request(app)
      .post("/manual-report-uploads/sync-source")
      .set("X-Client-Id", companyId)
      .send({})
      .expect(200);
    expect(res.body.processed).toEqual([]);
  });
});
