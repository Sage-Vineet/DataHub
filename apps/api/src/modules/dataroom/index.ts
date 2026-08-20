import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { ByteaStoragePort } from "../uploads/adapters.drizzle.js";
import type { StoragePort } from "../uploads/ports.js";
import {
  DrizzleChunkedStoragePort,
  DrizzleCommentsRepository,
  DrizzleDocumentRefPort,
  DrizzleDocumentVersionsRepository,
  DrizzleFolderGrantsPort,
  DrizzleUploadSessionsRepository,
} from "./repository.drizzle.js";
import { createDataRoomRouter } from "./router.js";
import { DataRoomService } from "./service.js";
import type { DataRoomActivityPort } from "./ports.js";

export interface DataRoomModule {
  router: Router;
  service: DataRoomService;
}

export interface CreateDataRoomModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
  /** Semantic activity events. Omitted → nothing is emitted, and nothing breaks. */
  activity?: DataRoomActivityPort;
  /** Sub-feature switches, so one unfinished capability can be killed alone. */
  features?: { versions?: boolean; comments?: boolean; chunkedUpload?: boolean };
  /**
   * Blob reads for version download. Defaults to the uploads module's own
   * `ByteaStoragePort` — the two modules deliberately share one blob store, and
   * this is the seam an object-store adapter would replace for both at once.
   */
  storage?: StoragePort;
}

export function createDataRoomModule(opts: CreateDataRoomModuleOptions): DataRoomModule {
  const service = new DataRoomService({
    versions: new DrizzleDocumentVersionsRepository(opts.db),
    comments: new DrizzleCommentsRepository(opts.db),
    sessions: new DrizzleUploadSessionsRepository(opts.db),
    storage: new DrizzleChunkedStoragePort(opts.db),
    documents: new DrizzleDocumentRefPort(opts.db),
    grants: new DrizzleFolderGrantsPort(opts.db),
    ...(opts.activity ? { activity: opts.activity } : {}),
  });
  return {
    router: createDataRoomRouter({
      service,
      requireAuth: opts.requireAuth,
      storage: opts.storage ?? new ByteaStoragePort(opts.db),
      ...(opts.features ? { features: opts.features } : {}),
    }),
    service,
  };
}

export { DataRoomService } from "./service.js";
export { createDataRoomRouter } from "./router.js";
export {
  DrizzleChunkedStoragePort,
  DrizzleCommentsRepository,
  DrizzleDocumentRefPort,
  DrizzleDocumentVersionsRepository,
  DrizzleFolderGrantsPort,
  DrizzleUploadSessionsRepository,
} from "./repository.drizzle.js";
export {
  DataRoomStore,
  memoryDataRoom,
  MemoryChunkedStorage,
  MemoryCommentsRepository,
  MemoryDocumentRef,
  MemorySessionsRepository,
  MemoryVersionsRepository,
} from "./repository.memory.js";
export type * from "./ports.js";
