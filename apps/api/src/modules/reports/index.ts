import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import {
  DrizzleEngagementPort,
  DrizzleLedgerDetailPort,
  LegacyReportSyncPort,
} from "./adapters.js";
import {
  DrizzleMappingsRepository,
  DrizzlePreferencesRepository,
  DrizzleReportsRepository,
  DrizzleSyncLogsRepository,
} from "./repository.drizzle.js";
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
    engagement: new DrizzleEngagementPort(opts.db),
    ledger: new DrizzleLedgerDetailPort(opts.db),
    mappings: new DrizzleMappingsRepository(opts.db),
    syncLogs: new DrizzleSyncLogsRepository(opts.db),
    preferences: new DrizzlePreferencesRepository(opts.db),
  });
  return { router: createReportsRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { ReportsService } from "./service.js";
export {
  DrizzleMappingsRepository,
  DrizzlePreferencesRepository,
  DrizzleReportsRepository,
  DrizzleSyncLogsRepository,
} from "./repository.drizzle.js";
export {
  InMemoryLedgerDetailPort,
  InMemoryMappingsRepository,
  InMemoryPreferencesRepository,
  InMemoryReportsRepository,
  InMemorySyncLogsRepository,
} from "./repository.memory.js";
export {
  LegacyReportSyncPort,
  DrizzleEngagementPort,
  DrizzleLedgerDetailPort,
} from "./adapters.js";
export { buildStatements, toBalanceSheetStatement, toCashFlowStatement } from "./statements.js";
export type { FinancialStatements } from "./statements.js";
export { createReportsRouter } from "./router.js";
export type {
  LedgerDetailPort,
  MappingRecord,
  MappingsRepository,
  LedgerTransaction,
  ReportsRepository,
  ReportSyncPort,
} from "./ports.js";
