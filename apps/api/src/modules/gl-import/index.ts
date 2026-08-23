import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import {
  DrizzleGlImportRepository,
  DrizzleLedgerWriter,
} from "./repository.drizzle.js";
import { DrizzleSyncRepository } from "../sync/repository.drizzle.js";
import { SyncService } from "../sync/service.js";
import { createGlImportRouter } from "./router.js";
import { GlImportService } from "./service.js";

export interface GlImportModule {
  router: Router;
  service: GlImportService;
}

export interface CreateGlImportModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Drizzle repo + service + router. */
export function createGlImportModule(opts: CreateGlImportModuleOptions): GlImportModule {
  const service = new GlImportService({
    repo: new DrizzleGlImportRepository(opts.db),
    ledger: new DrizzleLedgerWriter(opts.db),
  });
  // The sync service is constructed here rather than injected: an import IS a
  // sync run, and the two are one feature from a user's point of view.
  const sync = new SyncService({ repo: new DrizzleSyncRepository(opts.db) });
  return {
    router: createGlImportRouter({ service, sync, requireAuth: opts.requireAuth }),
    service,
  };
}

export { GlImportService } from "./service.js";
export {
  DrizzleGlImportRepository,
  DrizzleLedgerWriter,
} from "./repository.drizzle.js";
export { createGlImportRouter } from "./router.js";
export {
  ALL_FIELDS,
  CONFIDENCE_THRESHOLD,
  detectMapping,
  emptyMapping,
} from "./column-mapping.js";
export { applyMapping, parseSheet, SheetParseError } from "./sheet.js";
export { fiscalYearOf, hashRow, toLedgerEntries } from "./staging.js";
export { stageUploads } from "./service.js";
export type { ColumnMapping, MappingField, MappingResult } from "./column-mapping.js";
export type { ImportedRow, ParsedSheet } from "./sheet.js";
export type { GlImportRepository, LedgerWriter } from "./ports.js";
export type { LedgerEntry } from "./staging.js";
export type { StagingResult, StagedFile } from "./service.js";
