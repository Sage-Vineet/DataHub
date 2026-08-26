import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleSyncRepository } from "../sync/repository.drizzle.js";
import { SyncService } from "../sync/service.js";
import { DrizzleDatasetsRepository } from "./repository.drizzle.js";
import { createDatasetsRouter } from "./router.js";
import { DatasetsService } from "./service.js";

export interface DatasetsModule {
  router: Router;
  service: DatasetsService;
}

export interface CreateDatasetsModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/**
 * Drizzle repo + service + router.
 *
 * The sync service is constructed here rather than injected: upload jobs are
 * sync runs, and the two surfaces share one table by design (see the router).
 */
export function createDatasetsModule(opts: CreateDatasetsModuleOptions): DatasetsModule {
  const service = new DatasetsService({ repo: new DrizzleDatasetsRepository(opts.db) });
  const sync = new SyncService({ repo: new DrizzleSyncRepository(opts.db) });
  return {
    router: createDatasetsRouter({ service, sync, requireAuth: opts.requireAuth }),
    service,
  };
}

export { DatasetsService } from "./service.js";
export { DrizzleDatasetsRepository } from "./repository.drizzle.js";
export { createDatasetsRouter } from "./router.js";
export { DATASET_STATUSES } from "./ports.js";
export type { DatasetVersionRecord, DatasetsRepository } from "./ports.js";
