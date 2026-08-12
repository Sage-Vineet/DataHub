import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import {
  DrizzleCompanyStatsPort,
  DrizzleFolderProvisioningPort,
  DrizzleUserProvisioningPort,
} from "./adapters.drizzle.js";
import { DrizzleCompaniesRepository } from "./repository.drizzle.js";
import { createCompaniesRouter } from "./router.js";
import { CompaniesService } from "./service.js";
import type { FolderProvisioningPort } from "./ports.js";

export interface CompaniesModule {
  router: Router;
  service: CompaniesService;
}

export interface CreateCompaniesModuleOptions {
  db: Db;
  /** The shared session guard (Better Auth) — populates `req.user`. */
  requireAuth: RequestHandler;
  /**
   * Default-folder provisioning port (design D3). When the `folders` module is
   * enabled its real service is injected here (folders-domain D6); otherwise the
   * built-in Drizzle adapter provisions a basic set.
   */
  folderProvisioning?: FolderProvisioningPort;
}

/** Compose the companies module: Drizzle repo + cross-domain ports + service + router. */
export function createCompaniesModule(opts: CreateCompaniesModuleOptions): CompaniesModule {
  const service = new CompaniesService({
    repo: new DrizzleCompaniesRepository(opts.db),
    stats: new DrizzleCompanyStatsPort(opts.db),
    folders: opts.folderProvisioning ?? new DrizzleFolderProvisioningPort(opts.db),
    users: new DrizzleUserProvisioningPort(opts.db),
  });
  return { router: createCompaniesRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { CompaniesService, toCompanyResponse } from "./service.js";
export { DrizzleCompaniesRepository } from "./repository.drizzle.js";
export { InMemoryCompaniesRepository } from "./repository.memory.js";
export {
  DrizzleCompanyStatsPort,
  DrizzleFolderProvisioningPort,
  DrizzleUserProvisioningPort,
} from "./adapters.drizzle.js";
export { createCompaniesRouter } from "./router.js";
export type {
  CompaniesRepository,
  CompanyRecord,
  CompanyCreateInput,
  CompanyUpdatePatch,
  CompanyStats,
  CompanyStatsPort,
  FolderProvisioningPort,
  UserProvisioningPort,
} from "./ports.js";
