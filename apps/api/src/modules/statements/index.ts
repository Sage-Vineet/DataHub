import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import type { DocumentReader } from "../../shared/gemini.js";
import { CashFlowService } from "./cash-flow.js";
import { DashboardService, TaxComparisonService } from "./dashboard.js";
import { BankStatementsService } from "./bank-statements.js";
import { TaxReturnService } from "./tax-return.js";
import {
  DrizzleBankStatementDocumentPort,
  DrizzleDocumentBytesPort,
  DrizzleStatementDocumentPort,
  DrizzleTaxReturnDocumentPort,
} from "./tax-return.drizzle.js";
import { DrizzleStatementsRepository } from "./repository.drizzle.js";
import { createStatementsRouter } from "./router.js";
import { StatementsService } from "./service.js";

export interface StatementsModule {
  router: Router;
  service: StatementsService;
  cashFlow: CashFlowService;
  dashboard: DashboardService;
  taxComparison: TaxComparisonService;
  taxReturn: TaxReturnService | undefined;
  bankStatements: BankStatementsService | undefined;
}

export interface CreateStatementsModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
  /**
   * What reads a document.
   *
   * Absent where no model is configured, which is the common case in a test
   * and a legitimate one in a deployment that does not use extraction. The
   * route says so with a 503 rather than failing at a null.
   */
  reader?: DocumentReader;
}

/** Drizzle repo + service + router. */
export function createStatementsModule(
  opts: CreateStatementsModuleOptions,
): StatementsModule {
  const repo = new DrizzleStatementsRepository(opts.db);
  const service = new StatementsService({ repo });
  // The same repository, because a cash flow is a VIEW of the statements
  // already stored rather than a thing stored beside them.
  const cashFlow = new CashFlowService({ repo });
  // Derived on the request, for the same reason: the inputs are a handful of
  // rows and the derivation is arithmetic.
  const dashboard = new DashboardService({ repo });
  const taxComparison = new TaxComparisonService({ repo });

  // Reads the company's own linked tax return. Every query behind this filters
  // on the company — see `tax-return.drizzle.ts`.
  const taxReturn = opts.reader
    ? new TaxReturnService({
        statements: repo,
        documents: new DrizzleTaxReturnDocumentPort(opts.db),
        bytes: new DrizzleDocumentBytesPort(opts.db),
        reader: opts.reader,
      })
    : undefined;

  const bankStatements = opts.reader
    ? new BankStatementsService({
        statements: repo,
        documents: new DrizzleBankStatementDocumentPort(opts.db),
        // The balance sheet a version links, resolved the same way a tax
        // return is — company on both sides of the join.
        balanceSheetDocuments: new DrizzleStatementDocumentPort(opts.db, "balance_sheet", /balance\s*sheet|\bbs\b/i),
        bytes: new DrizzleDocumentBytesPort(opts.db),
        reader: opts.reader,
      })
    : undefined;

  return {
    router: createStatementsRouter({
      service,
      cashFlow,
      dashboard,
      taxComparison,
      ...(taxReturn ? { taxReturn } : {}),
      ...(bankStatements ? { bankStatements } : {}),
      requireAuth: opts.requireAuth,
    }),
    service,
    cashFlow,
    dashboard,
    taxComparison,
    taxReturn,
    bankStatements,
  };
}

export { StatementsService, isStatementType } from "./service.js";
export { DrizzleStatementsRepository } from "./repository.drizzle.js";
export { InMemoryStatementsRepository } from "./repository.memory.js";
export { createStatementsRouter } from "./router.js";
export { CashFlowService, MissingCashFlowInputsError } from "./cash-flow.js";
export { DashboardService, TaxComparisonService } from "./dashboard.js";
export { TaxReturnService, toTaxReturnFigures, toTaxReturnRows } from "./tax-return.js";
export { BankStatementsService } from "./bank-statements.js";
export type { TaxReturnFigures } from "./tax-return.js";
export type { SourceDashboard, DashboardYear } from "./dashboard.js";
export type { CashFlowPeriod } from "./cash-flow.js";
export { CATEGORY_OF_STATEMENT, STATEMENT_TYPES } from "./ports.js";
export type { StatementExtract, StatementType, StatementsRepository } from "./ports.js";
