import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleDatasetsRepository } from "../datasets/repository.drizzle.js";
import { DrizzleStatementsRepository } from "../statements/repository.drizzle.js";
import { DrizzleSyncRepository } from "../sync/repository.drizzle.js";
import { QuickBooksReportClient, QUICKBOOKS_BASE_URLS, type ReportFetcher } from "./reports/client.js";
import { QuickBooksEntitiesService } from "./reports/entities.js";
import { QuickBooksReportsService } from "./reports/service.js";
import { QuickBooksSyncStatusService } from "./reports/status.js";
import { DrizzleQuickBooksRepository } from "./repository.drizzle.js";
import { createQuickBooksRouter } from "./router.js";
import { QuickBooksService } from "./service.js";

export interface QuickBooksModule {
  router: Router;
  service: QuickBooksService;
  reports: QuickBooksReportsService;
  syncStatus: QuickBooksSyncStatusService;
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

  const reports = new QuickBooksReportsService({ statements, connections: repo, fetcher });

  // The sync's state is a read across three tables rather than a stored
  // duplicate of it. See `reports/status.ts`.
  const syncStatus = new QuickBooksSyncStatusService({
    runs: new DrizzleSyncRepository(opts.db),
    datasets: new DrizzleDatasetsRepository(opts.db),
    statements,
  });

  const entities = new QuickBooksEntitiesService({ statements, connections: repo, fetcher });

  return {
    router: createQuickBooksRouter({
      service,
      reports,
      syncStatus,
      entities,
      requireAuth: opts.requireAuth,
    }),
    service,
    reports,
    syncStatus,
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
export { QuickBooksEntitiesService } from "./reports/entities.js";
export type { QuickBooksSyncStatus } from "./reports/status.js";
export type { ConnectionRecord, QuickBooksRepository } from "./ports.js";
export type { ConnectionStatus } from "./service.js";
