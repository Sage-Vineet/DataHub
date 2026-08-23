import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleBankReconciliationRepository } from "./repository.drizzle.js";
import { createBankReconciliationRouter } from "./router.js";
import { BankReconciliationService } from "./service.js";

export interface BankReconciliationModule {
  router: Router;
  service: BankReconciliationService;
}

export interface CreateBankReconciliationModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Drizzle repo + service + router. */
export function createBankReconciliationModule(
  opts: CreateBankReconciliationModuleOptions,
): BankReconciliationModule {
  const service = new BankReconciliationService({
    repo: new DrizzleBankReconciliationRepository(opts.db),
  });
  return {
    router: createBankReconciliationRouter({ service, requireAuth: opts.requireAuth }),
    service,
  };
}

export { BankReconciliationService } from "./service.js";
export { DrizzleBankReconciliationRepository } from "./repository.drizzle.js";
export { InMemoryBankReconciliationRepository } from "./repository.memory.js";
export { createBankReconciliationRouter } from "./router.js";
export type {
  AddbackItemRecord,
  AdjustmentRecord,
  BankReconciliationRepository,
} from "./ports.js";
