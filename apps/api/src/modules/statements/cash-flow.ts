import type { SessionUser } from "@datahub/contracts";
import {
  buildStatementCashFlow,
  type StatementCashFlow,
  type StatementNode,
} from "@datahub/financial-engine";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { StatementExtract, StatementsRepository } from "./ports.js";

/**
 * Cash flow, derived from the statements a company has uploaded.
 *
 * A view over `statement_extracts`, not a thing stored beside them. Legacy
 * generated these during "Sync All" and cached the result in
 * `qb_synced_reports`, which meant the page answered 404 with "Run Sync All to
 * generate cash flow reports automatically" whenever nobody had — for data
 * that was already on file and already sufficient to compute it.
 *
 * There is nothing to cache. The inputs are two balance sheets and a P&L that
 * are already stored; the derivation is a pure function over them. A cache
 * here buys no measurable time and costs the one thing that actually goes
 * wrong: it goes stale, so re-uploading a corrected balance sheet leaves the
 * old cash flow on screen until somebody thinks to re-run a sync.
 */

/** A year for which a cash flow can be built, and how completely. */
export interface CashFlowPeriod {
  fiscalYear: number;
  /**
   * Whether the year before it is on file.
   *
   * Without it every movement is measured against nothing, so the statement
   * shows the P&L's addbacks and no working capital at all. Worth saying on
   * the picker rather than letting somebody wonder why a year looks empty.
   */
  hasPriorBalanceSheet: boolean;
}

export interface CashFlowServiceDeps {
  repo: StatementsRepository;
}

const rowsOf = (extract: StatementExtract | undefined): StatementNode[] => {
  const rows = (extract?.payload as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as StatementNode[]) : [];
};

/**
 * The one extract to use for a year.
 *
 * Newest first is already the repository's order, so the first match is the
 * most recently extracted — a corrected re-upload wins over the file it
 * corrects, which is the behaviour somebody re-uploading expects.
 */
const forYear = (extracts: readonly StatementExtract[], year: number) =>
  extracts.find((e) => e.fiscalYear === year);

export class CashFlowService {
  constructor(private readonly deps: CashFlowServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  private async inputs(companyId: string, sourceKey: string | undefined) {
    const filter = sourceKey ? { sourceKey } : {};
    const [balanceSheets, incomeStatements] = await Promise.all([
      this.deps.repo.list(companyId, { ...filter, statementType: "balance_sheet" }),
      this.deps.repo.list(companyId, { ...filter, statementType: "profit_and_loss" }),
    ]);
    return { balanceSheets, incomeStatements };
  }

  /**
   * Every year a cash flow can be built for.
   *
   * A year qualifies when it has BOTH a balance sheet and a P&L, because the
   * indirect method needs the movements from one and the profit from the
   * other. Legacy listed the years somebody had already generated and cached,
   * so a company with everything uploaded and no sync run showed an empty
   * picker.
   */
  async periods(
    user: SessionUser,
    companyId: string,
    options: { sourceKey?: string } = {},
  ): Promise<CashFlowPeriod[]> {
    this.requireCompany(user, companyId);
    const { balanceSheets, incomeStatements } = await this.inputs(companyId, options.sourceKey);

    const balanceSheetYears = new Set(
      balanceSheets.map((e) => e.fiscalYear).filter((y): y is number => y !== null),
    );
    const incomeYears = new Set(
      incomeStatements.map((e) => e.fiscalYear).filter((y): y is number => y !== null),
    );

    return [...balanceSheetYears]
      .filter((year) => incomeYears.has(year))
      .sort((a, b) => b - a)
      .map((fiscalYear) => ({
        fiscalYear,
        hasPriorBalanceSheet: balanceSheetYears.has(fiscalYear - 1),
      }));
  }

  /**
   * Build the cash flow for one year.
   *
   * When an input is missing it says WHICH — "Balance Sheet 2023" rather than
   * "no cash flow found". The person reading it is the person who can fix it
   * by uploading that file, and legacy's message told them to re-run a sync
   * that would not have helped.
   */
  async forFiscalYear(
    user: SessionUser,
    companyId: string,
    fiscalYear: number,
    options: { sourceKey?: string } = {},
  ): Promise<StatementCashFlow> {
    this.requireCompany(user, companyId);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) {
      throw new BadRequestError(`Not a fiscal year: ${fiscalYear}.`);
    }

    const { balanceSheets, incomeStatements } = await this.inputs(companyId, options.sourceKey);
    const currentBalanceSheet = forYear(balanceSheets, fiscalYear);
    const incomeStatement = forYear(incomeStatements, fiscalYear);

    const missing: string[] = [];
    if (!currentBalanceSheet) missing.push(`Balance Sheet ${fiscalYear}`);
    if (!incomeStatement) missing.push(`Profit and Loss ${fiscalYear}`);
    if (missing.length > 0) {
      throw new MissingCashFlowInputsError(fiscalYear, missing);
    }

    // The prior year is optional. Its absence makes for a thinner statement,
    // not a refusal — the first year a company is on file still has a P&L
    // worth showing, and a blank page explains nothing.
    const priorBalanceSheet = forYear(balanceSheets, fiscalYear - 1);

    return buildStatementCashFlow({
      priorBalanceSheet: rowsOf(priorBalanceSheet),
      currentBalanceSheet: rowsOf(currentBalanceSheet),
      incomeStatement: rowsOf(incomeStatement),
      fiscalYear,
    });
  }
}

/**
 * The inputs a cash flow needed and did not have.
 *
 * Its own error because the answer carries a list the caller renders, rather
 * than a sentence it prints — the page turns `missingInputs` into the files to
 * go and upload.
 */
export class MissingCashFlowInputsError extends NotFoundError {
  constructor(
    readonly fiscalYear: number,
    readonly missingInputs: string[],
  ) {
    super(
      `Cannot build a ${fiscalYear} cash flow: ${missingInputs.join(" and ")} ` +
        `${missingInputs.length === 1 ? "is" : "are"} not on file.`,
    );
    this.name = "MissingCashFlowInputsError";
  }
}
