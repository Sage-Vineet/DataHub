import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleWorkspaceRepository } from "./repository.drizzle.js";
import { createWorkspaceRouter } from "./router.js";
import { WorkspaceService } from "./service.js";

export interface WorkspaceModule {
  router: Router;
  service: WorkspaceService;
}

export interface CreateWorkspaceModuleOptions {
  db: Db;
  /** The shared session guard (Better Auth) — populates `req.user`. */
  requireAuth: RequestHandler;
}

/** Compose the workspace module: Drizzle repo + service + router. */
export function createWorkspaceModule(opts: CreateWorkspaceModuleOptions): WorkspaceModule {
  const service = new WorkspaceService({ repo: new DrizzleWorkspaceRepository(opts.db) });
  return { router: createWorkspaceRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { WorkspaceService, scopedPageKey, CIM_QUESTIONNAIRE_PAGE_KEY } from "./service.js";
export type { PageStateResponse, QuestionnaireState } from "./service.js";
export { DrizzleWorkspaceRepository } from "./repository.drizzle.js";
export { InMemoryWorkspaceRepository } from "./repository.memory.js";
export { createWorkspaceRouter, resolveCompanyId } from "./router.js";
export type { WorkspaceRepository, PageStateRecord } from "./ports.js";
