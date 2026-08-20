import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import {
  DrizzleDecksRepository,
  DrizzleProvenanceRepository,
  DrizzlePublicationsRepository,
  DrizzleQuestionLibraryRepository,
  DrizzleStructureRepository,
  DrizzleVersionsRepository,
} from "./repository.drizzle.js";
import { createCimRouter } from "./router.js";
import { CimService } from "./service.js";
import type { CimActivityPort, CimDataRoomPort, QaPort } from "./ports.js";

export interface CimModule {
  router: Router;
  service: CimService;
}

export interface CreateCimModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
  activity?: CimActivityPort;
  /**
   * Where a published CIM lands. Omitted → publication reports the data room as
   * unavailable rather than failing obscurely.
   */
  dataRoom?: CimDataRoomPort;
  /**
   * The guided-Q&A seam. Omitted → generation reports unavailable and everything
   * else in the builder keeps working, which is what a kill switch on the Q&A
   * module should feel like from here.
   */
  qa?: QaPort;
}

const unavailableDataRoom: CimDataRoomPort = {
  available: false,
  publishDocument: async () => {
    throw new Error("data room unavailable");
  },
};

const unavailableQa: QaPort = {
  available: false,
  createItems: async () => [],
  listAnswers: async () => [],
  outstandingCount: async () => 0,
};

export function createCimModule(opts: CreateCimModuleOptions): CimModule {
  const service = new CimService({
    decks: new DrizzleDecksRepository(opts.db),
    versions: new DrizzleVersionsRepository(opts.db),
    structure: new DrizzleStructureRepository(opts.db),
    provenance: new DrizzleProvenanceRepository(opts.db),
    library: new DrizzleQuestionLibraryRepository(opts.db),
    publications: new DrizzlePublicationsRepository(opts.db),
    dataRoom: opts.dataRoom ?? unavailableDataRoom,
    qa: opts.qa ?? unavailableQa,
    ...(opts.activity ? { activity: opts.activity } : {}),
  });
  return { router: createCimRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { CimService } from "./service.js";
export { createCimRouter } from "./router.js";
export { DEFAULT_OUTLINE } from "./outline.js";
export { DrizzleCimDataRoomPort, QaServiceAdapter } from "./adapters.js";
export * from "./repository.drizzle.js";
export {
  CimStore,
  memoryCim,
  unavailableCimDataRoom,
  unavailableQa as memoryUnavailableQa,
} from "./repository.memory.js";
export type * from "./ports.js";
