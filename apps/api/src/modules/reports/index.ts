import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { LegacyReportSyncPort } from "./adapters.js";
import { DrizzleReportsRepository } from "./repository.drizzle.js";
import { createReportsRouter } from "./router.js";
import { ReportsService } from "./service.js";

export interface ReportsModule {
  router: Router;
  service: ReportsService;
}

export interface CreateReportsModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Compose the reports module: Drizzle repo + (stub) sync port + service + router. */
export function createReportsModule(opts: CreateReportsModuleOptions): ReportsModule {
  const service = new ReportsService({
    repo: new DrizzleReportsRepository(opts.db),
    sync: new LegacyReportSyncPort(),
  });
  return { router: createReportsRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { ReportsService } from "./service.js";
export { DrizzleReportsRepository } from "./repository.drizzle.js";
export { InMemoryReportsRepository } from "./repository.memory.js";
export { LegacyReportSyncPort } from "./adapters.js";
export { createReportsRouter } from "./router.js";
export type { ReportsRepository, ReportSyncPort } from "./ports.js";
