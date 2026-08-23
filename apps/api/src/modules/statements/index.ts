import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { CashFlowService } from "./cash-flow.js";
import { DrizzleStatementsRepository } from "./repository.drizzle.js";
import { createStatementsRouter } from "./router.js";
import { StatementsService } from "./service.js";

export interface StatementsModule {
  router: Router;
  service: StatementsService;
  cashFlow: CashFlowService;
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
  return {
    router: createStatementsRouter({ service, cashFlow, requireAuth: opts.requireAuth }),
    service,
    cashFlow,
  };
}

export { StatementsService, isStatementType } from "./service.js";
export { DrizzleStatementsRepository } from "./repository.drizzle.js";
export { InMemoryStatementsRepository } from "./repository.memory.js";
export { createStatementsRouter } from "./router.js";
export { CashFlowService, MissingCashFlowInputsError } from "./cash-flow.js";
export type { CashFlowPeriod } from "./cash-flow.js";
export { CATEGORY_OF_STATEMENT, STATEMENT_TYPES } from "./ports.js";
export type { StatementExtract, StatementType, StatementsRepository } from "./ports.js";
