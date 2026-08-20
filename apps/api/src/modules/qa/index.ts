import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import {
  DrizzleAssigneesRepository,
  DrizzleCategoriesRepository,
  DrizzleDataRoomAttachmentPort,
  DrizzleDealMemberPort,
  DrizzleItemsRepository,
  DrizzlePresentationsRepository,
  DrizzleResponsesRepository,
} from "./repository.drizzle.js";
import { createQaRouter } from "./router.js";
import { QaService } from "./service.js";
import type { DataRoomAttachmentPort, QaActivityPort } from "./ports.js";

export interface QaModule {
  router: Router;
  service: QaService;
}

export interface CreateQaModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
  activity?: QaActivityPort;
  features?: { presentation?: boolean; nominations?: boolean };
  /**
   * Filing evidence into the data room.
   *
   * When the data room capability is switched off, pass the null adapter: the
   * attachment route then reports unavailable and every other Q&A route keeps
   * working. A kill switch that takes out a neighbouring feature is not a kill
   * switch.
   */
  dataRoom?: DataRoomAttachmentPort;
}

export function createQaModule(opts: CreateQaModuleOptions): QaModule {
  const service = new QaService({
    categories: new DrizzleCategoriesRepository(opts.db),
    items: new DrizzleItemsRepository(opts.db),
    assignees: new DrizzleAssigneesRepository(opts.db),
    responses: new DrizzleResponsesRepository(opts.db),
    presentations: new DrizzlePresentationsRepository(opts.db),
    members: new DrizzleDealMemberPort(opts.db),
    dataRoom: opts.dataRoom ?? new DrizzleDataRoomAttachmentPort(opts.db),
    ...(opts.activity ? { activity: opts.activity } : {}),
  });
  return {
    router: createQaRouter({
      service,
      requireAuth: opts.requireAuth,
      ...(opts.features ? { features: opts.features } : {}),
    }),
    service,
  };
}

export { QaService } from "./service.js";
export { createQaRouter } from "./router.js";
export * from "./repository.drizzle.js";
export {
  QaStore,
  memoryQa,
  unavailableDataRoom,
  MemoryAssigneesRepository,
  MemoryCategoriesRepository,
  MemoryDataRoomAttachmentPort,
  MemoryDealMemberPort,
  MemoryItemsRepository,
  MemoryPresentationsRepository,
  MemoryResponsesRepository,
} from "./repository.memory.js";
export type * from "./ports.js";
