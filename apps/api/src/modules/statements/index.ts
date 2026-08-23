import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { CashFlowService } from "./cash-flow.js";
import { DashboardService } from "./dashboard.js";
import { DrizzleStatementsRepository } from "./repository.drizzle.js";
import { createStatementsRouter } from "./router.js";
import { StatementsService } from "./service.js";

export interface StatementsModule {
  router: Router;
  service: StatementsService;
  cashFlow: CashFlowService;
  dashboard: DashboardService;
}

export interface CreateStatementsModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
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
  return {
    router: createStatementsRouter({
      service,
      cashFlow,
      dashboard,
      requireAuth: opts.requireAuth,
    }),
    service,
    cashFlow,
    dashboard,
  };
}

export { StatementsService, isStatementType } from "./service.js";
export { DrizzleStatementsRepository } from "./repository.drizzle.js";
export { InMemoryStatementsRepository } from "./repository.memory.js";
export { createStatementsRouter } from "./router.js";
export { CashFlowService, MissingCashFlowInputsError } from "./cash-flow.js";
export { DashboardService } from "./dashboard.js";
export type { SourceDashboard, DashboardYear } from "./dashboard.js";
export type { CashFlowPeriod } from "./cash-flow.js";
export { CATEGORY_OF_STATEMENT, STATEMENT_TYPES } from "./ports.js";
export type { StatementExtract, StatementType, StatementsRepository } from "./ports.js";
