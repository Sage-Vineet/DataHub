import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleReportSourcesRepository } from "./repository.drizzle.js";
import { createReportSourcesRouter } from "./router.js";
import { ReportSourcesService } from "./service.js";

export interface ReportSourcesModule {
  router: Router;
  service: ReportSourcesService;
}

export interface CreateReportSourcesModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Drizzle repo + service + router. */
export function createReportSourcesModule(
  opts: CreateReportSourcesModuleOptions,
): ReportSourcesModule {
  const service = new ReportSourcesService({
    repo: new DrizzleReportSourcesRepository(opts.db),
  });
  return {
    router: createReportSourcesRouter({ service, requireAuth: opts.requireAuth }),
    service,
  };
}

export { ReportSourcesService, availabilityOf, isReportSourceKey } from "./service.js";
export { DrizzleReportSourcesRepository } from "./repository.drizzle.js";
export { InMemoryReportSourcesRepository } from "./repository.memory.js";
export { createReportSourcesRouter } from "./router.js";
export {
  ALL_SOURCE_KEYS,
  REPORT_SOURCE_KEYS,
  REPORT_SOURCE_LABELS,
} from "./ports.js";
export type { ReportSourceKey, ReportSourcesRepository, SourceRecord } from "./ports.js";
