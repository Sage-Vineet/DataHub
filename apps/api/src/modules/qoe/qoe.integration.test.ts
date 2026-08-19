import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema, type Db } from "@datahub/db";
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

const DDL = `
CREATE TYPE company_status AS ENUM ('active','inactive');
CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, project_name text, industry text,
  status company_status NOT NULL DEFAULT 'active', since date, logo text, contact_name text,
  contact_email text, contact_phone text, profit_metric text NOT NULL DEFAULT 'adjusted_ebitda',
  market_rate_replacement_salary numeric(18,2),
  data_source_type text, quickbooks_connected boolean NOT NULL DEFAULT false,
  manual_upload_active boolean NOT NULL DEFAULT false, last_source_switch_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, email text);
CREATE TABLE key_report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_number integer NOT NULL, version_name text, status text NOT NULL DEFAULT 'draft',
  is_active boolean NOT NULL DEFAULT false, resolved_batch_id uuid, resolved_dataset_version integer,
  last_synced_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_by uuid, updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE chart_of_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_number text, account_name text NOT NULL, parent_account_id uuid,
  account_type text, statement_type text, is_active boolean NOT NULL DEFAULT true,
  sort_order integer, ebitda_role text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
-- Mirrors backend/sql/migrations/049 + 050 + the coa_id reconciliation in
-- packages/db/migrations/0002, including the NOT NULL columns a real row carries.
CREATE TABLE general_ledger_entries (
  id bigint PRIMARY KEY, version_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_file_id uuid NOT NULL, transaction_date date, fiscal_year integer,
  account_number text NOT NULL, account_name text NOT NULL, coa_id uuid,
  row_type text NOT NULL DEFAULT 'TRANSACTION', amount numeric(18,2),
  vendor_name text, memo_description text);
CREATE TABLE balance_sheet_entries (
  id bigint PRIMARY KEY, version_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_file_id uuid, as_of_date date NOT NULL, fiscal_year integer,
  account_name text, account_number text, account_type text,
  section text, sub_section text, amount numeric(18,2),
  hierarchy_level integer, sort_order integer,
  is_total boolean DEFAULT false, is_generated boolean DEFAULT false, coa_id uuid);
CREATE TABLE qoe_addbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id text NOT NULL, kind text NOT NULL,
  data_source text NOT NULL DEFAULT 'company_financials', type_key text NOT NULL, name text NOT NULL,
  linked_account_id text, vendor_scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  granularity text NOT NULL DEFAULT 'detail', values jsonb NOT NULL DEFAULT '{}'::jsonb,
  recast_normalized_value numeric(18,2), group_id text, group_label text,
  explanation text, commentary text, qa_citation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
`;

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
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as Db;

  companyId = randomUUID();
  versionId = randomUUID();
  await db.insert(schema.companies).values({
    id: companyId,
    name: engagementFixture.company.name,
    profitMetric: "adjusted_ebitda",
  });
  await client.exec(
    `INSERT INTO key_report_versions (id, company_id, version_number, is_active)
     VALUES ('${versionId}', '${companyId}', 1, true);`,
  );

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
        asOfDate: asOf,
        fiscalYear: Number(asOf.slice(0, 4)),
        accountName: row.name,
        section: PLURAL[row.section] ?? row.section,
        subSection: row.group,
        amount: String(row.amount),
        sortOrder: order,
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
