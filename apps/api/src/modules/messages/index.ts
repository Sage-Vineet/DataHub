import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleMessagesRepository } from "./repository.drizzle.js";
import { createMessagesRouter } from "./router.js";
import { MessagesService } from "./service.js";

export interface MessagesModule {
  router: Router;
  service: MessagesService;
}

export interface CreateMessagesModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Compose the messages module: Drizzle repo + service + router. */
export function createMessagesModule(opts: CreateMessagesModuleOptions): MessagesModule {
  const service = new MessagesService({ repo: new DrizzleMessagesRepository(opts.db) });
  return { router: createMessagesRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { MessagesService } from "./service.js";
export { DrizzleMessagesRepository } from "./repository.drizzle.js";
export { InMemoryMessagesRepository } from "./repository.memory.js";
export { createMessagesRouter } from "./router.js";
export type { MessagesRepository } from "./ports.js";
