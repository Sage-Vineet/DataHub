import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleReconciliationTransactionsRepository } from "../bank-reconciliation/repository.drizzle.js";
import { DrizzleDatasetsRepository } from "../datasets/repository.drizzle.js";
import { DrizzleStatementsRepository } from "../statements/repository.drizzle.js";
import { DrizzleSyncRepository } from "../sync/repository.drizzle.js";
import { SyncService } from "../sync/service.js";
import { QuickBooksReportClient, QUICKBOOKS_BASE_URLS, type ReportFetcher } from "./reports/client.js";
import { QuickBooksEntitiesService } from "./reports/entities.js";
import { QuickBooksReportsService } from "./reports/service.js";
import { QuickBooksSyncStatusService } from "./reports/status.js";
import { QuickBooksSyncService } from "./reports/sync.js";
import { DrizzleQuickBooksRepository } from "./repository.drizzle.js";
import { createQuickBooksRouter } from "./router.js";
import { QuickBooksService } from "./service.js";

export interface QuickBooksModule {
  router: Router;
  service: QuickBooksService;
  reports: QuickBooksReportsService;
  syncStatus: QuickBooksSyncStatusService;
  sync: QuickBooksSyncService;
  entities: QuickBooksEntitiesService;
}

export interface CreateQuickBooksModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
  /** The application secret. Token-sealing keys are derived from it. */
  secret: string;
  /**
   * Where Intuit lives.
   *
   * Defaults to production. Set to the sandbox host to work against a sandbox
   * realm — which is also what makes the live path exercisable at all, since
   * nothing short of a real realm proves Intuit accepts the request.
   */
  quickBooksBaseUrl?: string;
  /** Injected in tests, so nothing here needs a network. */
  fetcher?: ReportFetcher;
}

/** Drizzle repo + service + router. */
export function createQuickBooksModule(
  opts: CreateQuickBooksModuleOptions,
): QuickBooksModule {
  const repo = new DrizzleQuickBooksRepository(opts.db, opts.secret);
  const service = new QuickBooksService({ repo });

  // Pulled reports live in `statement_extracts` alongside the ones read out of
  // uploaded files — same columns, different provenance. See migration 0011.
  const statements = new DrizzleStatementsRepository(opts.db);
  const fetcher =
    opts.fetcher ??
    new QuickBooksReportClient({
      baseUrl: opts.quickBooksBaseUrl ?? QUICKBOOKS_BASE_URLS.production,
    });

  const reports = new QuickBooksReportsService({
    statements,
    connections: repo,
    fetcher,
    // A fetched general ledger lands in two places: the report goes to
    // `statement_extracts`, its rows to the books side of the reconciliation.
    ledgerTransactions: new DrizzleReconciliationTransactionsRepository(opts.db),
  });

  // The sync's state is a read across three tables rather than a stored
  // duplicate of it. See `reports/status.ts`.
  const runs = new DrizzleSyncRepository(opts.db);
  const syncStatus = new QuickBooksSyncStatusService({
    runs,
    datasets: new DrizzleDatasetsRepository(opts.db),
    statements,
  });

  // The sync goes through `SyncService` rather than the repository, so the
  // reaping and the refusal of a second concurrent run are the same code every
  // other sync uses.
  const sync = new QuickBooksSyncService({ runs: new SyncService({ repo: runs }), reports });

  const entities = new QuickBooksEntitiesService({ statements, connections: repo, fetcher });

  return {
    router: createQuickBooksRouter({
      service,
      reports,
      syncStatus,
      sync,
      entities,
      requireAuth: opts.requireAuth,
    }),
    service,
    reports,
    syncStatus,
    sync,
    entities,
  };
}

export { QuickBooksService } from "./service.js";
export { DrizzleQuickBooksRepository } from "./repository.drizzle.js";
export { InMemoryQuickBooksRepository } from "./repository.memory.js";
export { createQuickBooksRouter } from "./router.js";
export {
  QuickBooksAuthError,
  QuickBooksReportClient,
  QuickBooksRequestError,
  QUICKBOOKS_BASE_URLS,
} from "./reports/client.js";
export type { QbReportType, ReportFetcher } from "./reports/client.js";
export { QuickBooksReportsService, QUICKBOOKS_SOURCE_KEY } from "./reports/service.js";
export { QuickBooksSyncStatusService } from "./reports/status.js";
export { QuickBooksSyncService, buildSyncPlan, SYNC_REPORT_TYPES } from "./reports/sync.js";
export { QuickBooksEntitiesService } from "./reports/entities.js";
export type { QuickBooksSyncStatus } from "./reports/status.js";
export type { ConnectionRecord, QuickBooksRepository } from "./ports.js";
export type { ConnectionStatus } from "./service.js";
