import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleRequestsRepository } from "./repository.drizzle.js";
import { createRequestsRouter } from "./router.js";
import { RequestsService } from "./service.js";

export interface RequestsModule {
  router: Router;
  service: RequestsService;
}

export interface CreateRequestsModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Compose the requests module: Drizzle repo + service + router. */
export function createRequestsModule(opts: CreateRequestsModuleOptions): RequestsModule {
  const service = new RequestsService({ repo: new DrizzleRequestsRepository(opts.db) });
  return { router: createRequestsRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { RequestsService, toResponse } from "./service.js";
export { DrizzleRequestsRepository } from "./repository.drizzle.js";
export { InMemoryRequestsRepository } from "./repository.memory.js";
export { createRequestsRouter } from "./router.js";
export type { RequestsRepository, RequestRecord } from "./ports.js";
