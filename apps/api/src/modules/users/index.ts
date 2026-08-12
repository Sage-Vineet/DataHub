import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { ConsoleEmailerPort, ConsoleNotificationPort, NoopAuthCachePort } from "./adapters.js";
import { DrizzleUsersRepository } from "./repository.drizzle.js";
import { createUsersRouter } from "./router.js";
import { UsersService } from "./service.js";

export interface UsersModule {
  router: Router;
  service: UsersService;
}

export interface CreateUsersModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Compose the users module: Drizzle repo + side-effect ports + service + router. */
export function createUsersModule(opts: CreateUsersModuleOptions): UsersModule {
  const service = new UsersService({
    repo: new DrizzleUsersRepository(opts.db),
    emailer: new ConsoleEmailerPort(),
    notifications: new ConsoleNotificationPort(),
    authCache: new NoopAuthCachePort(),
  });
  return { router: createUsersRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { UsersService } from "./service.js";
export { DrizzleUsersRepository } from "./repository.drizzle.js";
export { InMemoryUsersRepository } from "./repository.memory.js";
export { computeEffectiveRole, isRequestRestricted, isBrokerTeamSubRole } from "./roles.js";
export { createUsersRouter } from "./router.js";
export type {
  UsersRepository,
  UserRecord,
  UserCreateInput,
  UserUpdatePatch,
  EmailerPort,
  NotificationPort,
  AuthCachePort,
} from "./ports.js";
