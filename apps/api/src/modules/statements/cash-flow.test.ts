import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import { CashFlowService, MissingCashFlowInputsError } from "./cash-flow.js";
import { InMemoryStatementsRepository } from "./repository.memory.js";

/**
 * The cash flow, derived on the request rather than stored.
 *
 * The version this replaces served it from a cache written during "Sync All",
 * so a company with every input uploaded still read "Run Sync All to generate
 * cash flow reports" until somebody did. The inputs are on file and the
 * derivation is a pure function over them.
 *
 * What is left here is the refusals — and they matter because a cash flow
 * built from a missing prior year is not obviously wrong on the page.
 */

const COMPANY = randomUUID();
const OTHER = randomUUID();
const SOURCE = "manual_upload_excel_pdf";

const USER: SessionUser = {
  id: randomUUID(),
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

function build() {
  const repo = new InMemoryStatementsRepository();
  return { repo, service: new CashFlowService({ repo }) };
}

/** A statement of the shape the derivation reads. */
const save = (
  repo: InMemoryStatementsRepository,
  documentId: string,
  statementType: "balance_sheet" | "profit_and_loss",
  fiscalYear: number,
  rows: unknown[],
  sourceKey = SOURCE,
) => {
  repo.seedDocument(documentId, `${statementType}-${fiscalYear}.pdf`);
  return repo.save({
    companyId: COMPANY,
    provenance: { from: "document", documentId },
    statementType,
    sourceKey,
    periodStart: null,
    periodEnd: `${fiscalYear}-12-31`,
    asOfDate: `${fiscalYear}-12-31`,
    fiscalYear,
    payload: { rows },
    extractedBy: null,
  });
};

const balanceSheet = (cash: number, payables: number) => [
  { name: "Cash", amount: cash, type: "asset" },
  { name: "Accounts Payable", amount: payables, type: "liability" },
];

const profitAndLoss = (netIncome: number) => [
  { name: "Net Income", amount: netIncome, type: "income" },
];

describe("which years a cash flow can be built for", () => {
  it("reports none for a company with nothing on file", async () => {
    const { service } = build();
    expect(await service.periods(USER, COMPANY, {})).toEqual([]);
  });

  it("reports a year that has both inputs", async () => {
    const { repo, service } = build();
    save(repo, "bs-2025", "balance_sheet", 2025, balanceSheet(1_000, 400));
    save(repo, "pl-2025", "profit_and_loss", 2025, profitAndLoss(300));

    const periods = await service.periods(USER, COMPANY, {});
    expect(periods.map((p) => p.fiscalYear)).toContain(2025);
  });

  it("says whether a year has a prior balance sheet to compare against", async () => {
    // Without one the statement is thinner, not absent — so the page needs to
    // know which it is getting rather than discovering it in the figures.
    const { repo, service } = build();
    save(repo, "bs-2024", "balance_sheet", 2024, balanceSheet(800, 300));
    save(repo, "pl-2024", "profit_and_loss", 2024, profitAndLoss(200));
    save(repo, "bs-2025", "balance_sheet", 2025, balanceSheet(1_000, 400));
    save(repo, "pl-2025", "profit_and_loss", 2025, profitAndLoss(300));

    const periods = await service.periods(USER, COMPANY, {});
    expect(periods.find((p) => p.fiscalYear === 2025)?.hasPriorBalanceSheet).toBe(true);
    expect(periods.find((p) => p.fiscalYear === 2024)?.hasPriorBalanceSheet).toBe(false);
  });

  it("narrows to one source when asked", async () => {
    const { repo, service } = build();
    save(repo, "bs-2025", "balance_sheet", 2025, balanceSheet(1_000, 400));
    save(repo, "pl-2025", "profit_and_loss", 2025, profitAndLoss(300));

    expect(await service.periods(USER, COMPANY, { sourceKey: "quickbooks" })).toEqual([]);
    expect((await service.periods(USER, COMPANY, { sourceKey: SOURCE })).length).toBeGreaterThan(0);
  });
});

describe("building one", () => {
  const seedBoth = (repo: InMemoryStatementsRepository) => {
    save(repo, "bs-2024", "balance_sheet", 2024, balanceSheet(800, 300));
    save(repo, "pl-2024", "profit_and_loss", 2024, profitAndLoss(200));
    save(repo, "bs-2025", "balance_sheet", 2025, balanceSheet(1_000, 400));
    save(repo, "pl-2025", "profit_and_loss", 2025, profitAndLoss(300));
  };

  it("derives it from the statements on file", async () => {
    const { repo, service } = build();
    seedBoth(repo);
    const result = await service.forFiscalYear(USER, COMPANY, 2025);
    expect(result.fiscalYear).toBe(2025);
  });

  it("names what is missing rather than reporting a thinner statement", async () => {
    // The page turns `missingInputs` into the files to go and upload. A cash
    // flow built from half its inputs is not obviously wrong on the page.
    const { repo, service } = build();
    save(repo, "bs-2025", "balance_sheet", 2025, balanceSheet(1_000, 400));

    const error = await service
      .forFiscalYear(USER, COMPANY, 2025)
      .then(() => null)
      .catch((e: unknown) => e as MissingCashFlowInputsError);

    expect(error).toBeInstanceOf(MissingCashFlowInputsError);
    expect(error?.missingInputs).toEqual(["Profit and Loss 2025"]);
    expect(error?.message).toMatch(/is not on file/);
  });

  it("names both when both are missing, and says \"are\"", async () => {
    const { service } = build();
    const error = await service
      .forFiscalYear(USER, COMPANY, 2025)
      .then(() => null)
      .catch((e: unknown) => e as MissingCashFlowInputsError);

    expect(error?.missingInputs).toEqual(["Balance Sheet 2025", "Profit and Loss 2025"]);
    expect(error?.message).toMatch(/are not on file/);
  });

  it("builds a first year with no prior balance sheet at all", async () => {
    // The prior year is optional: the first year a company is on file still
    // has a P&L and a closing position, and refusing it would make the
    // earliest year permanently unreportable.
    const { repo, service } = build();
    save(repo, "bs-2025", "balance_sheet", 2025, balanceSheet(1_000, 400));
    save(repo, "pl-2025", "profit_and_loss", 2025, profitAndLoss(300));

    await expect(service.forFiscalYear(USER, COMPANY, 2025)).resolves.toBeDefined();
  });

  it("refuses a year that could not be one", async () => {
    const { service } = build();
    for (const year of [0, 1899, 2201, 20.5, Number.NaN]) {
      await expect(service.forFiscalYear(USER, COMPANY, year)).rejects.toBeInstanceOf(
        BadRequestError,
      );
    }
  });

  it("reads a statement whose payload carries no rows as empty", async () => {
    // An extract stored before the row tree existed, or one the model returned
    // nothing usable for. It should not throw the whole cash flow.
    const { repo, service } = build();
    save(repo, "bs-2025", "balance_sheet", 2025, "not a list" as never);
    save(repo, "pl-2025", "profit_and_loss", 2025, profitAndLoss(300));

    await expect(service.forFiscalYear(USER, COMPANY, 2025)).resolves.toBeDefined();
  });

  it("refuses a company the caller cannot reach, and one named nowhere", async () => {
    const { service } = build();
    await expect(service.forFiscalYear(USER, OTHER, 2025)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.forFiscalYear(USER, "", 2025)).rejects.toBeInstanceOf(BadRequestError);
    await expect(service.periods(USER, "", {})).rejects.toBeInstanceOf(BadRequestError);
  });
});
