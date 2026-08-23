import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleStatementsRepository } from "./repository.drizzle.js";
import { createStatementsRouter } from "./router.js";
import { StatementsService } from "./service.js";

export interface StatementsModule {
  router: Router;
  service: StatementsService;
}

export interface CreateStatementsModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Drizzle repo + service + router. */
export function createStatementsModule(
  opts: CreateStatementsModuleOptions,
): StatementsModule {
  const service = new StatementsService({ repo: new DrizzleStatementsRepository(opts.db) });
  return {
    router: createStatementsRouter({ service, requireAuth: opts.requireAuth }),
    service,
  };
}

export { StatementsService, isStatementType } from "./service.js";
export { DrizzleStatementsRepository } from "./repository.drizzle.js";
export { InMemoryStatementsRepository } from "./repository.memory.js";
export { createStatementsRouter } from "./router.js";
export { CATEGORY_OF_STATEMENT, STATEMENT_TYPES } from "./ports.js";
export type { StatementExtract, StatementType, StatementsRepository } from "./ports.js";
