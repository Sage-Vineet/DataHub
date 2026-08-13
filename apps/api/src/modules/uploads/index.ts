import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { ByteaStoragePort, DrizzleFolderRefPort } from "./adapters.drizzle.js";
import { DrizzleDocumentsRepository } from "./repository.drizzle.js";
import { createUploadsRouter } from "./router.js";
import { UploadsService } from "./service.js";

export interface UploadsModule {
  router: Router;
  service: UploadsService;
}

export interface CreateUploadsModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Compose the uploads module: bytea StoragePort + documents repo + folder-ref + service + router. */
export function createUploadsModule(opts: CreateUploadsModuleOptions): UploadsModule {
  const service = new UploadsService({
    storage: new ByteaStoragePort(opts.db),
    repo: new DrizzleDocumentsRepository(opts.db),
    folders: new DrizzleFolderRefPort(opts.db),
  });
  return { router: createUploadsRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { UploadsService, toDocumentResponse } from "./service.js";
export { ByteaStoragePort, DrizzleFolderRefPort } from "./adapters.drizzle.js";
export { DrizzleDocumentsRepository } from "./repository.drizzle.js";
export {
  InMemoryDocumentsRepository,
  InMemoryStoragePort,
  InMemoryFolderRefPort,
} from "./repository.memory.js";
export { createUploadsRouter } from "./router.js";
export type {
  StoragePort,
  FolderRefPort,
  DocumentsRepository,
  DocumentRecord,
  ActivityRecord,
} from "./ports.js";
