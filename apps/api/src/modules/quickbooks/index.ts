import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleQuickBooksRepository } from "./repository.drizzle.js";
import { createQuickBooksRouter } from "./router.js";
import { QuickBooksService } from "./service.js";

export interface QuickBooksModule {
  router: Router;
  service: QuickBooksService;
}

export interface CreateQuickBooksModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
  /** The application secret. Token-sealing keys are derived from it. */
  secret: string;
}

/** Drizzle repo + service + router. */
export function createQuickBooksModule(
  opts: CreateQuickBooksModuleOptions,
): QuickBooksModule {
  const service = new QuickBooksService({
    repo: new DrizzleQuickBooksRepository(opts.db, opts.secret),
  });
  return {
    router: createQuickBooksRouter({ service, requireAuth: opts.requireAuth }),
    service,
  };
}

export { QuickBooksService } from "./service.js";
export { DrizzleQuickBooksRepository } from "./repository.drizzle.js";
export { InMemoryQuickBooksRepository } from "./repository.memory.js";
export { createQuickBooksRouter } from "./router.js";
export type { ConnectionRecord, QuickBooksRepository } from "./ports.js";
export type { ConnectionStatus } from "./service.js";
