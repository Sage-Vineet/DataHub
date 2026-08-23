import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleGlImportRepository } from "./repository.drizzle.js";
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
  const service = new GlImportService({ repo: new DrizzleGlImportRepository(opts.db) });
  return {
    router: createGlImportRouter({ service, requireAuth: opts.requireAuth }),
    service,
  };
}

export { GlImportService } from "./service.js";
export { DrizzleGlImportRepository } from "./repository.drizzle.js";
export { createGlImportRouter } from "./router.js";
export {
  ALL_FIELDS,
  CONFIDENCE_THRESHOLD,
  detectMapping,
  emptyMapping,
} from "./column-mapping.js";
export { applyMapping, parseSheet, SheetParseError } from "./sheet.js";
export type { ColumnMapping, MappingField, MappingResult } from "./column-mapping.js";
export type { ImportedRow, ParsedSheet } from "./sheet.js";
export type { GlImportRepository } from "./ports.js";
