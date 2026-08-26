import type { DocumentReader } from "../../shared/gemini.js";
import { DrizzleStatementsRepository } from "../statements/repository.drizzle.js";
import { DrizzleDocumentBytesPort } from "../statements/tax-return.drizzle.js";
import { KeyReportSyncService } from "./key-report-sync.js";
import {
  DrizzleStatementEntryWriter,
  DrizzleSyncLogWriter,
} from "./key-report-sync.drizzle.js";
import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import {
  DrizzleEngagementPort,
  DrizzleLedgerDetailPort,
  UnavailableReportSyncPort,
} from "./adapters.js";
import {
  DrizzleMappingsRepository,
  DrizzlePreferencesRepository,
  DrizzleReportsRepository,
  DrizzleSyncLogsRepository,
} from "./repository.drizzle.js";
import { createReportsRouter } from "./router.js";
import { ExtractedDataReader } from "./extracted-data.js";
import { ReportsService } from "./service.js";

export interface ReportsModule {
  router: Router;
  service: ReportsService;
}

export interface CreateReportsModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
  /**
   * Reads a statement out of a document.
   *
   * Absent where no model is configured: the sync port then answers 503 naming
   * the configuration, rather than this module pretending it can extract.
   */
  reader?: DocumentReader;
}

/** Compose the reports module: Drizzle repo + sync port + service + router. */
export function createReportsModule(opts: CreateReportsModuleOptions): ReportsModule {
  const repo = new DrizzleReportsRepository(opts.db);

  // The sync reads the version's linked statements into the entry tables the
  // financial engine runs on. Without a model there is nothing to read them
  // with, and the port says so rather than this module guessing.
  const sync = opts.reader
    ? new KeyReportSyncService({
        versions: repo,
        statements: new DrizzleStatementsRepository(opts.db),
        entries: new DrizzleStatementEntryWriter(opts.db),
        logs: new DrizzleSyncLogWriter(opts.db),
        bytes: new DrizzleDocumentBytesPort(opts.db),
        reader: opts.reader,
      })
    : new UnavailableReportSyncPort();

  const service = new ReportsService({
    repo,
    sync,
    engagement: new DrizzleEngagementPort(opts.db),
    ledger: new DrizzleLedgerDetailPort(opts.db),
    mappings: new DrizzleMappingsRepository(opts.db),
    syncLogs: new DrizzleSyncLogsRepository(opts.db),
    preferences: new DrizzlePreferencesRepository(opts.db),
    extractedData: new ExtractedDataReader(opts.db),
  });
  return { router: createReportsRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { ReportsService } from "./service.js";
export {
  EXTRACTED_DATA_TYPES,
  ExtractedDataReader,
  isExtractedDataType,
  toLikePattern,
  toPage,
  toPageSize,
} from "./extracted-data.js";
export type { ExtractedDataPage, ExtractedDataQuery, ExtractedDataType } from "./extracted-data.js";
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
  UnavailableReportSyncPort,
  DrizzleEngagementPort,
  DrizzleLedgerDetailPort,
} from "./adapters.js";
export { KeyReportSyncService } from "./key-report-sync.js";
export {
  DrizzleStatementEntryWriter,
  DrizzleSyncLogWriter,
} from "./key-report-sync.drizzle.js";
export { flattenStatement, splitAccountName } from "./statement-entries.js";
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
