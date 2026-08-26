import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleGroupsRepository } from "./repository.drizzle.js";
import { createGroupsRouter } from "./router.js";
import { GroupsService } from "./service.js";

export interface GroupsModule {
  router: Router;
  service: GroupsService;
}

export interface CreateGroupsModuleOptions {
  db: Db;
  /** The shared session guard (Better Auth) — populates `req.user`. */
  requireAuth: RequestHandler;
}

/** Compose the groups module: Drizzle repo + service + router. */
export function createGroupsModule(opts: CreateGroupsModuleOptions): GroupsModule {
  const service = new GroupsService({ repo: new DrizzleGroupsRepository(opts.db) });
  return { router: createGroupsRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { GroupsService, toGroupResponse, toMemberResponse } from "./service.js";
export type { GroupResponse, GroupMemberResponse } from "./service.js";
export { DrizzleGroupsRepository } from "./repository.drizzle.js";
export { InMemoryGroupsRepository } from "./repository.memory.js";
export { createGroupsRouter } from "./router.js";
export type {
  GroupsRepository,
  GroupRecord,
  GroupMemberRecord,
  GroupCreateInput,
  GroupUpdatePatch,
} from "./ports.js";
