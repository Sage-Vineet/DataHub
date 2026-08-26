import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { ReconcileService } from "./reconcile.js";
import {
  DrizzleBankReconciliationRepository,
  DrizzleReconciliationTransactionsRepository,
} from "./repository.drizzle.js";
import { createBankReconciliationRouter } from "./router.js";
import { BankReconciliationService } from "./service.js";

export interface BankReconciliationModule {
  router: Router;
  service: BankReconciliationService;
  reconcile: ReconcileService;
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
  // Its own repository: the grid's editable cells and the raw sides of the
  // comparison are different questions, and nothing needs both at once.
  const reconcile = new ReconcileService({
    repo: new DrizzleReconciliationTransactionsRepository(opts.db),
  });
  return {
    router: createBankReconciliationRouter({ service, reconcile, requireAuth: opts.requireAuth }),
    service,
    reconcile,
  };
}

export { BankReconciliationService } from "./service.js";
export { DrizzleBankReconciliationRepository } from "./repository.drizzle.js";
export { InMemoryBankReconciliationRepository } from "./repository.memory.js";
export { InMemoryReconciliationTransactionsRepository } from "./repository.memory.js";
export { DrizzleReconciliationTransactionsRepository } from "./repository.drizzle.js";
export { ReconcileService } from "./reconcile.js";
export { createBankReconciliationRouter } from "./router.js";
export type {
  AddbackItemRecord,
  AdjustmentRecord,
  BankReconciliationRepository,
  BankTransaction,
  BookTransaction,
  BookTransactionInput,
  ReconciliationTransactionsRepository,
} from "./ports.js";
