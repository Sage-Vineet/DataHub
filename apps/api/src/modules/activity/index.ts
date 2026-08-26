import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleActivityRepository } from "./repository.drizzle.js";
import { createActivityRouter } from "./router.js";
import { ActivityService } from "./service.js";

export interface ActivityModule {
  router: Router;
  service: ActivityService;
}

export interface CreateActivityModuleOptions {
  db: Db;
  /** The shared session guard (Better Auth) — populates `req.user`. */
  requireAuth: RequestHandler;
}

/** Compose the activity module: Drizzle repo + service + router. */
export function createActivityModule(opts: CreateActivityModuleOptions): ActivityModule {
  const service = new ActivityService({ repo: new DrizzleActivityRepository(opts.db) });
  return { router: createActivityRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { ActivityService } from "./service.js";
export { DrizzleActivityRepository } from "./repository.drizzle.js";
export { InMemoryActivityRepository } from "./repository.memory.js";
export { createActivityRouter } from "./router.js";
export {
  buildBrokerFeed,
  clampLimit,
  DEFAULT_ACTIVITY_LIMIT,
  MAX_ACTIVITY_LIMIT,
  PER_SOURCE_LIMIT,
} from "./feed.js";
export type { ActivityEvent, BrokerActivitySources } from "./feed.js";
export type { ActivityRepository, ActivityScope } from "./ports.js";
