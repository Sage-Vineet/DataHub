import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleFileLinkPort, DrizzleGroupRefPort } from "./adapters.js";
import { DrizzleFoldersRepository } from "./repository.drizzle.js";
import { createFoldersRouter } from "./router.js";
import { FoldersService } from "./service.js";

export interface FoldersModule {
  router: Router;
  service: FoldersService;
}

export interface CreateFoldersModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Compose the folders module: Drizzle repo + cross-domain ports + service + router. */
export function createFoldersModule(opts: CreateFoldersModuleOptions): FoldersModule {
  const service = new FoldersService({
    repo: new DrizzleFoldersRepository(opts.db),
    fileLink: new DrizzleFileLinkPort(opts.db),
    groups: new DrizzleGroupRefPort(opts.db),
  });
  return { router: createFoldersRouter({ service, requireAuth: opts.requireAuth }), service };
}

/**
 * The real `FolderProvisioningPort` for `companies-domain` (folders-domain D6):
 * a structural adapter over this module's provisioning service. Companies injects
 * this instead of its own basic adapter once folders is enabled.
 */
export function createFolderProvisioningPort(db: Db): {
  ensureDefaultFolders(companyId: string, createdBy: string): Promise<void>;
} {
  const service = new FoldersService({
    repo: new DrizzleFoldersRepository(db),
    fileLink: new DrizzleFileLinkPort(db),
    groups: new DrizzleGroupRefPort(db),
  });
  return {
    async ensureDefaultFolders(companyId: string, createdBy: string): Promise<void> {
      await service.ensureDefaultFolders(companyId, createdBy);
    },
  };
}

export { FoldersService, buildTree, toFolderResponse } from "./service.js";
export { DrizzleFoldersRepository } from "./repository.drizzle.js";
export { InMemoryFoldersRepository } from "./repository.memory.js";
export { DrizzleFileLinkPort, DrizzleGroupRefPort } from "./adapters.js";
export { DEFAULT_HIERARCHY, EXPECTED_FOLDER_COUNT } from "./hierarchy.js";
export { createFoldersRouter } from "./router.js";
export type {
  FoldersRepository,
  FolderRecord,
  FolderAccessRecord,
  FileLinkPort,
  GroupRefPort,
} from "./ports.js";
