import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleSyncRepository } from "./repository.drizzle.js";
import { createSyncRouter } from "./router.js";
import { SyncService } from "./service.js";

export interface SyncModule {
  router: Router;
  service: SyncService;
}

export interface CreateSyncModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Drizzle repo + service + router. */
export function createSyncModule(opts: CreateSyncModuleOptions): SyncModule {
  const service = new SyncService({ repo: new DrizzleSyncRepository(opts.db) });
  return {
    router: createSyncRouter({ service, requireAuth: opts.requireAuth }),
    service,
  };
}

export { SyncService } from "./service.js";
export { DrizzleSyncRepository } from "./repository.drizzle.js";
export { InMemorySyncRepository } from "./repository.memory.js";
export { createSyncRouter } from "./router.js";
export { STALE_AFTER_MS, isStalled, percentageOf, toProgress } from "./progress.js";
export type { SyncProgress, SyncRepository, SyncRunRecord } from "./ports.js";
