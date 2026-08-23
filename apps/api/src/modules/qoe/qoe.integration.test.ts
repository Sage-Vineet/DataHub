import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { engagementFixture } from "@datahub/financial-engine";
import { createQoeRouter } from "./router.js";
import { DrizzleQoeRepository } from "./repository.drizzle.js";
import { QoeService } from "./service.js";

/**
 * End-to-end proof that the QuickBooks-sourced ledger produces the engagement
 * workbook's figures.
 *
 * The anonymized walkthrough engagement is loaded into the REAL table shapes
 * (`chart_of_accounts`, `general_ledger_entries`), read back through the REAL
 * Drizzle repository, and served over HTTP. Nothing is stubbed between the
 * ledger rows and the JSON response — so a green run here means the pipeline,
 * not just the arithmetic, agrees with the workbook.
 */


const BROKER: SessionUser = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Reviewer", email: "reviewer@example.com", role: "broker",
  company_id: null, status: "active", company_ids: [],
};

let client: PGlite;
let db: Db;
let app: express.Express;
let current: SessionUser;
let companyId: string;
let versionId: string;
/** Fixture slug → the uuid it was loaded under. */
let accountUuid: Map<string, string>;
const SOURCE_FILE_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;

  companyId = randomUUID();
  versionId = randomUUID();
  await db.insert(schema.companies).values({
    id: companyId,
    name: engagementFixture.company.name,
    industry: "",
    profitMetric: "adjusted_ebitda",
  });
  await client.exec(
    `INSERT INTO key_report_versions (id, company_id, version_number, is_active)
     VALUES ('${versionId}', '${companyId}', 1, true);`,
  );

  // general_ledger_entries.source_file_id is a real foreign key to documents, so
  // the ledger has to point at a document that exists — the same referential
  // shape tools/demo/seed-qoe.mjs builds. The hand-written DDL declared it as a
  // bare uuid, so the fixture could invent one.
  // The acting user, not an invented one: qoe_addbacks.created_by is a real
  // foreign key, so an add-back created in a test has to be created by someone.
  const userId = BROKER.id;
  const folderId = randomUUID();
  await client.exec(`
    INSERT INTO users (id, name, email, password_hash, role, company_id)
    VALUES ('${userId}', 'Broker', 'b-${userId}@x.test', '!', 'broker', '${companyId}');
    INSERT INTO folders (id, company_id, name, created_by)
    VALUES ('${folderId}', '${companyId}', 'Financials', '${userId}');
    INSERT INTO documents (id, company_id, folder_id, name, file_url, size, ext, status, uploaded_by)
    VALUES ('${SOURCE_FILE_ID}', '${companyId}', '${folderId}', 'GL.xlsx', '', '1', 'xlsx',
            'under-review', '${userId}');
  `);

  // ── load the chart of accounts ────────────────────────────────────────────
  // `ebitdaRole` is deliberately NOT seeded. A freshly ingested engagement has
  // no classification, and the classifier has to produce it — seeding the flag
  // would test the fixture rather than the system.
  accountUuid = new Map();
  for (const account of engagementFixture.accounts) {
    const id = randomUUID();
    accountUuid.set(account.id, id);
    await db.insert(schema.chartOfAccounts).values({
      id,
      versionId,
      companyId,
      accountName: account.name,
      accountType: account.accountType ?? null,
      statementType: account.statementType,
      ebitdaRole: null,
    });
  }

  // ── load the ledger ───────────────────────────────────────────────────────
  const rows = engagementFixture.glEntries.map((entry, index) => ({
    id: index + 1,
    versionId,
    companyId,
    // A real GL row carries a date; the repository derives the month from it.
    transactionDate: `${entry.fiscalYear}-${String(Math.min(Math.max(entry.month, 1), 12)).padStart(2, "0")}-15`,
    fiscalYear: entry.fiscalYear,
    accountName: entry.accountId,
    accountNumber: "",
    sourceFileId: SOURCE_FILE_ID,
    coaId: accountUuid.get(entry.accountId)!,
    rowType: "TRANSACTION",
    amount: String(entry.amount),
    vendor: entry.vendor ?? null,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(schema.generalLedgerEntries).values(rows.slice(i, i + 500));
  }

  // ── load both balance-sheet statements ────────────────────────────────────
  // Section names are the plural form the extractor writes, so the repository's
  // mapping to the engine's singular is exercised rather than assumed.
  const PLURAL: Record<string, string> = {
    asset: "assets",
    liability: "liabilities",
    equity: "equity",
  };
  let bsId = 1;
  for (const sheet of engagementFixture.balanceSheets) {
    const asOf = sheet.anchor === "starting" ? "2021-12-31" : "2025-12-31";
    for (const [order, row] of sheet.rows.entries()) {
      await db.insert(schema.balanceSheetEntries).values({
        id: bsId++,
        versionId,
        companyId,
        sourceFileId: SOURCE_FILE_ID,
        asOfDate: asOf,
        fiscalYear: Number(asOf.slice(0, 4)),
        accountName: row.name,
        section: PLURAL[row.section] ?? row.section,
        subSection: row.group,
        amount: String(row.amount),
        sortOrder: order,
        // The real extractor writes level 1 for statement accounts (see
        // tools/demo/seed-qoe.mjs); the column defaults to 0, so leaving it
        // unset made every seeded row look like a parent caption once a level-1
        // row appeared beside it.
        hierarchyLevel: 1,
        isTotal: false,
        isGenerated: false,
        coaId: accountUuid.get(
          row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        ) ?? null,
      });
    }
  }

  current = { ...BROKER, company_ids: [companyId] };
  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  const service = new QoeService({ repo: new DrizzleQoeRepository(db) });
  app = express();
  app.use("/", createQoeRouter({ service, requireAuth }));
});

afterEach(async () => {
  await client.close();
});

/** The step a real engagement takes first: classify, then read the bridge. */
async function classify() {
  return request(app).post(`/qoe/versions/${versionId}/classify`).expect(200);
}

describe("classification (real Postgres, unclassified chart of accounts)", () => {
  it("assigns the roles this engagement needs, and no income tax", async () => {
    const report = (await classify()).body;
    const applied = report.applied.map((c: { accountName: string; role: string }) =>
      `${c.accountName} → ${c.role}`).sort();
    expect(applied).toEqual([
      "Depreciation → depreciation",
      "Interest Income → interest_income",
      "Interest Paid → interest_expense",
    ]);
    expect(report.applied_count).toBe(3);
  });

  it("records why each operating tax was left out", async () => {
    const report = (await classify()).body;
    for (const name of ["Meals Tax", "Real estate taxes", "Taxes & Licenses", "Payroll taxes"]) {
      const entry = report.unclassified.find(
        (c: { accountName: string }) => c.accountName === name,
      );
      expect(entry, name).toBeDefined();
      expect(entry.rule).toBe("exclude.operating-tax");
    }
  });

  it("a dry run reports without writing", async () => {
    const dry = (await request(app)
      .post(`/qoe/versions/${versionId}/classify?dry_run=true`)
      .expect(200)).body;
    expect(dry.applied.length).toBe(3);
    expect(dry.applied_count).toBe(0);

    // The bridge is still unclassified, so Reported EBITDA is still net income.
    const bridge = (await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2024`)).body;
    expect(bridge.ebitLines).toHaveLength(0);
    expect(bridge.reportedEbitda["2024"]).toBeCloseTo(47568.23, 2);
  });

  it("turns an unclassified engagement into the workbook's figures", async () => {
    const before = (await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2024`)).body;
    expect(before.reportedEbitda["2024"]).toBeCloseTo(47568.23, 2);

    await classify();

    const after = (await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2024`)).body;
    expect(after.reportedEbitda["2024"]).toBeCloseTo(347403.35, 2);
  });

  it("is idempotent", async () => {
    await classify();
    const second = (await classify()).body;
    expect(second.applied_count).toBe(3);
    const bridge = (await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2024`)).body;
    expect(bridge.reportedEbitda["2024"]).toBeCloseTo(347403.35, 2);
  });
});

describe("balance sheet and trial balance over HTTP", () => {
  it("balances in every period, rolled from the ingested statements", async () => {
    const res = await request(app)
      .get(`/qoe/balance-sheet?version_id=${versionId}`)
      .expect(200);

    const broken = res.body.checks
      .filter((c: { balances: boolean }) => !c.balances)
      .map((c: { period: string; outOfBalance: number }) => `${c.period}: ${c.outOfBalance}`);
    expect(broken, "every period must satisfy A = L + E").toEqual([]);
    expect(res.body.balances).toBe(true);
    expect(res.body.periods).toHaveLength(48);
  });

  it("ties to the closing statement it was not rolled from", async () => {
    const res = await request(app).get(`/qoe/balance-sheet?version_id=${versionId}`);
    expect(res.body.tieOut).not.toBeNull();
    expect(res.body.tieOut.differences).toEqual({});
    expect(res.body.tieOut.ties).toBe(true);
  });

  it("closes retained earnings to the stated ending figure", async () => {
    const res = await request(app).get(`/qoe/balance-sheet?version_id=${versionId}`);
    expect(res.body.retainedEarnings["2025-12"]).toBeCloseTo(112021.03, 2);
    expect(res.body.netIncome["2025-12"]).toBeCloseTo(169495.9, 2);
  });

  it("gives balance-sheet accounts real openings and P&L accounts zero", async () => {
    const res = await request(app)
      .get(`/qoe/trial-balance?version_id=${versionId}`)
      .expect(200);

    expect(res.body.balances, "debits must equal credits in every period").toBe(true);

    const y2024 = res.body.entries.find((e: { period: string }) => e.period === "2024");
    const pl = y2024.rows.filter(
      (r: { statementType: string; openingBalance: number }) =>
        r.statementType === "profit_loss" && r.openingBalance !== 0,
    );
    expect(pl, "P&L accounts open at zero each fiscal year").toEqual([]);

    const inventory = y2024.rows.find(
      (r: { accountName: string }) => r.accountName === "Inventory",
    );
    expect(inventory.openingBalance).not.toBe(0);
    expect(inventory.closingBalance).toBeCloseTo(
      inventory.openingBalance + inventory.movement,
      2,
    );
  });

  it("ignores parent captions that extraction leaves in the statement (UAT #4)", async () => {
    // Extraction filters subtotals but not headings, so a parent like "Bank
    // Accounts" arrives carrying the total of the accounts beneath it. Counting
    // it would double those balances and break the sheet.
    const before = (await request(app).get(`/qoe/balance-sheet?version_id=${versionId}`)).body;

    await db.insert(schema.balanceSheetEntries).values([
      {
        id: 900001, versionId, companyId, sourceFileId: SOURCE_FILE_ID, asOfDate: "2021-12-31", fiscalYear: 2021,
        accountName: "Bank Accounts", section: "assets", amount: "331021.02",
        sortOrder: 999, isTotal: false, isGenerated: false, hierarchyLevel: 0,
      },
      {
        id: 900002, versionId, companyId, sourceFileId: SOURCE_FILE_ID, asOfDate: "2021-12-31", fiscalYear: 2021,
        accountName: "Fixed Assets", section: "assets", amount: "1010393.10",
        sortOrder: 998, isTotal: false, isGenerated: false, hierarchyLevel: 1,
      },
    ]);

    const after = (await request(app).get(`/qoe/balance-sheet?version_id=${versionId}`)).body;

    expect(after.balances, "the sheet must still balance").toBe(true);
    expect(after.lines).toHaveLength(before.lines.length);
    expect(after.lines.map((l: { accountName: string }) => l.accountName)).not.toContain(
      "Bank Accounts",
    );
    expect(after.checks.at(-1).assets).toBeCloseTo(before.checks.at(-1).assets, 2);
  });

  it("refuses when no balance sheet has been ingested", async () => {
    await db.delete(schema.balanceSheetEntries);
    const res = await request(app)
      .get(`/qoe/balance-sheet?version_id=${versionId}`)
      .expect(409);
    expect(res.body.error).toMatch(/No balance sheet has been ingested/);
  });
});

describe("QoE bridge over HTTP (real Postgres, real ledger)", () => {
  it("reproduces the engagement workbook figures from the general ledger", async () => {
    await classify();
    const res = await request(app).get(`/qoe/bridge?version_id=${versionId}`).expect(200);
    const bridge = res.body;

    // Net income, per "Data walkthrough 05.05.2026.xlsx".
    expect(bridge.netIncome.amounts["2022"]).toBeCloseTo(115896.38, 2);
    expect(bridge.netIncome.amounts["2023"]).toBeCloseTo(104079.12, 2);
    expect(bridge.netIncome.amounts["2024"]).toBeCloseTo(47568.23, 2);
    expect(bridge.netIncome.amounts["2025"]).toBeCloseTo(169495.9, 2);

    // Revenue, same source.
    expect(bridge.revenue["2024"]).toBeCloseTo(2511740.83, 2);

    // Reported EBITDA = NI + interest expense − interest income + D&A + tax.
    expect(bridge.reportedEbitda["2024"]).toBeCloseTo(347403.35, 2);
  });

  it("itemizes the EBIT lines from the chart of accounts, not from labels", async () => {
    await classify();
    const bridge = (await request(app).get(`/qoe/bridge?version_id=${versionId}`)).body;
    const line = (key: string) =>
      bridge.ebitLines.find((l: { key: string }) => l.key === key);

    expect(line("interest_expense").amounts["2024"]).toBeCloseTo(87176.03, 2);
    expect(line("interest_income").amounts["2024"]).toBeCloseTo(-5115.91, 2);
    expect(line("depreciation").amounts["2024"]).toBeCloseTo(217775, 2);

    // No account is flagged as income tax, so there is no income tax line —
    // even though three accounts have "tax" in their name.
    expect(line("income_tax")).toBeUndefined();
    expect(bridge.unflaggedAccounts).toEqual(
      expect.arrayContaining(["Meals Tax", "Real estate taxes", "Taxes & Licenses"]),
    );
  });

  it("selects periods discretely and aggregates monthly on request", async () => {
    await classify();
    const annual = (
      await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2023,2025`)
    ).body;
    expect(annual.periods.map((p: { label: string }) => p.label)).toEqual(["FY2023", "FY2025"]);

    const monthly = (
      await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2024&aggregation=monthly`)
    ).body;
    expect(monthly.periods).toHaveLength(12);
    const summed = Object.values(monthly.reportedEbitda as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(summed).toBeCloseTo(347403.35, 1);
  });

  it("runs the add-back through the ledger and into the metric", async () => {
    await classify();
    const created = await request(app)
      .post("/qoe/addbacks")
      .send({
        version_id: versionId,
        company_id: companyId,
        kind: "pnl_account_vendor",
        type_key: "personal_expense",
        name: "Meals & entertainment",
        linked_account_id: accountUuid.get("meals-entertainment"),
      })
      .expect(201);

    const bridge = (
      await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2024`)
    ).body;
    const item = bridge.addbackGroups[0].items[0];
    expect(item.amounts["2024"]).toBeCloseTo(1163.86, 2);
    expect(bridge.adjusted["2024"]).toBeCloseTo(347403.35 + 1163.86, 2);

    await request(app).delete(`/qoe/addbacks/${created.body.id}`).expect(204);
    const after = (await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2024`)).body;
    expect(after.adjusted["2024"]).toBeCloseTo(347403.35, 2);
  });

  it("refuses a manual adjustment with no explanation and a hand-typed GL amount", async () => {
    await request(app)
      .post("/qoe/addbacks")
      .send({
        version_id: versionId, company_id: companyId,
        kind: "manual_adjustment", type_key: "other_addback", name: "Unexplained",
        values: { "2024": 5000 },
      })
      .expect(400);

    await request(app)
      .post("/qoe/addbacks")
      .send({
        version_id: versionId, company_id: companyId,
        kind: "pnl_account_vendor", type_key: "other_addback", name: "Hand-typed",
        linked_account_id: accountUuid.get("meals-entertainment"),
        values: { "2024": 999999 },
      })
      .expect(400);
  });

  it("moves Reported EBITDA when an account role is assigned", async () => {
    await classify();
    const mealsTax = accountUuid.get("meals-tax")!;
    await request(app)
      .put(`/qoe/versions/${versionId}/accounts/${mealsTax}/role`)
      .send({ ebitda_role: "income_tax" })
      .expect(204);

    const bridge = (
      await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2024`)
    ).body;
    expect(bridge.reportedEbitda["2024"]).toBeCloseTo(347403.35 + 37820.18, 2);
  });

  it("reclassifies an account and derives its statement (UAT #2)", async () => {
    await classify();
    const mealsTax = accountUuid.get("meals-tax")!;

    await request(app)
      .put(`/qoe/versions/${versionId}/accounts/${mealsTax}/classification`)
      .send({ account_type: "asset" })
      .expect(204);

    // Reclassified to a balance-sheet account, it must leave the P&L entirely:
    // FY2024 expenses drop by its full amount and net income rises to match.
    const bridge = (await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2024`)).body;
    expect(bridge.netIncome.amounts["2024"]).toBeCloseTo(47568.23 + 37820.18, 2);

    // And it is no longer offered as a P&L account to classify.
    const report = (await request(app)
      .post(`/qoe/versions/${versionId}/classify?dry_run=true`)).body;
    const names = [
      ...report.applied, ...report.suggested, ...report.unclassified,
    ].map((c: { accountName: string }) => c.accountName);
    expect(names).not.toContain("Meals Tax");
  });

  it("keeps a reclassification to cost of sales, rather than reading it back as expense", async () => {
    // This round-trip used to lose. The write landed `cogs` in the database and
    // every read came back `expense`, because `loadEngagement` collapsed all
    // non-income P&L accounts to a single type — so the reclassification looked
    // like it had silently done nothing, and gross profit could not be derived.
    await classify();
    const mealsTax = accountUuid.get("meals-tax")!;

    const before = (await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2024`)).body;

    await request(app)
      .put(`/qoe/versions/${versionId}/accounts/${mealsTax}/classification`)
      .send({ account_type: "cogs" })
      .expect(204);

    const after = (await request(app).get(`/qoe/bridge?version_id=${versionId}&years=2024`)).body;

    // Still a cost, so the bottom line must not move an inch.
    expect(after.netIncome.amounts["2024"]).toBeCloseTo(before.netIncome.amounts["2024"], 2);

    // The read-back is the whole point: the statement must report the account
    // as cost of sales, and gross profit must fall by exactly its amount.
    const statement = (
      await request(app).get(`/qoe/income-statement?version_id=${versionId}&years=2024`)
    ).body;
    const line = statement.lines.find(
      (l: { account_name: string }) => l.account_name === "Meals Tax",
    );
    expect(line.account_type).toBe("cogs");
    expect(statement.cost_of_sales["2024"]).toBeCloseTo(37820.18, 2);
    expect(statement.gross_profit["2024"]).toBeCloseTo(
      statement.revenue["2024"] - 37820.18,
      2,
    );

    // And it is still a P&L account — reclassifying within the statement must
    // not push it off the statement, which is what `asset` does above.
    const report = (await request(app)
      .post(`/qoe/versions/${versionId}/classify?dry_run=true`)).body;
    const names = [
      ...report.applied, ...report.suggested, ...report.unclassified,
    ].map((c: { accountName: string }) => c.accountName);
    expect(names).toContain("Meals Tax");
  });

  it("refuses a classification that is not a real account type", async () => {
    const mealsTax = accountUuid.get("meals-tax")!;
    await request(app)
      .put(`/qoe/versions/${versionId}/accounts/${mealsTax}/classification`)
      .send({ account_type: "revenue-ish" })
      .expect(400);
  });

  it("blocks a company the user cannot access", async () => {
    current = { ...BROKER, company_ids: [] };
    await request(app).get(`/qoe/bridge?version_id=${versionId}`).expect(403);
  });
});

/**
 * The product had no working P&L anywhere.
 *
 * `buildIncomeStatement` has existed and been tested against the workbook the
 * whole time; nothing routed to it. The Reports page asked legacy, legacy
 * reached for Supabase, and the Profit & Loss tab stayed disabled.
 *
 * These assertions pin the two things that make the statement worth trusting:
 * it ties to the same net income the bridge and balance sheet already agree on,
 * and it does NOT reproduce the revenue-plus-expenses inversion that the
 * extracted `profit_loss_entries` table contains — FY2024 reports $4,975,913
 * there against a true net income of $47,568.
 */
describe("income statement over HTTP (real Postgres, real ledger)", () => {
  it("ties to the net income the rest of the engagement reports", async () => {
    const res = await request(app)
      .get(`/qoe/income-statement?version_id=${versionId}`)
      .expect(200);

    expect(res.body.net_income["2024"]).toBeCloseTo(47568.23, 2);
    expect(res.body.net_income["2025"]).toBeCloseTo(169495.9, 2);
  });

  it("does not reproduce the revenue-plus-expenses inversion", async () => {
    const res = await request(app).get(`/qoe/income-statement?version_id=${versionId}`);
    // The inverted table's FY2024 figure. Anything near it means the sign
    // convention was lost somewhere between the ledger and the wire.
    expect(res.body.net_income["2024"]).toBeLessThan(1_000_000);
    expect(res.body.revenue["2024"]).toBeGreaterThan(0);
    expect(res.body.expenses["2024"]).toBeGreaterThan(0);
  });

  it("foots: revenue minus expenses equals net income, every period", async () => {
    const res = await request(app).get(`/qoe/income-statement?version_id=${versionId}`);
    for (const period of res.body.periods) {
      const key = String(period.fiscalYear);
      const derived = res.body.revenue[key] - res.body.expenses[key];
      expect(derived, `FY${key} must foot`).toBeCloseTo(res.body.net_income[key], 2);
    }
  });

  it("serialises the per-account breakdown instead of shipping an empty Map", async () => {
    const res = await request(app).get(`/qoe/income-statement?version_id=${versionId}`);
    expect(Array.isArray(res.body.lines)).toBe(true);
    expect(res.body.lines.length).toBeGreaterThan(0);
    const line = res.body.lines[0];
    expect(line.account_name).toBeTruthy();
    expect(line.account_name).not.toBe("Unknown account");
    expect(Object.keys(line.amounts).length).toBeGreaterThan(0);
  });

  it("honours a year filter and monthly aggregation", async () => {
    const annual = await request(app)
      .get(`/qoe/income-statement?version_id=${versionId}&years=2025`)
      .expect(200);
    expect(annual.body.periods).toHaveLength(1);

    const monthly = await request(app)
      .get(`/qoe/income-statement?version_id=${versionId}&years=2025&aggregation=monthly`)
      .expect(200);
    expect(monthly.body.periods).toHaveLength(12);

    // Monthly columns must sum back to the annual figure.
    const summed = monthly.body.periods.reduce(
      (total: number, p: { fiscalYear: number; month: number }) =>
        total + monthly.body.net_income[`${p.fiscalYear}-${String(p.month).padStart(2, "0")}`],
      0,
    );
    expect(summed).toBeCloseTo(annual.body.net_income["2025"], 2);
  });

  it("refuses a version the caller cannot access", async () => {
    await request(app)
      .get(`/qoe/income-statement?version_id=${randomUUID()}`)
      .expect((r) => expect([403, 404]).toContain(r.status));
  });
});
