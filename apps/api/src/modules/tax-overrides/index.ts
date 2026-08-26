import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { DrizzleTaxOverridesRepository } from "./repository.drizzle.js";
import { createTaxOverridesRouter } from "./router.js";
import { TaxOverridesService } from "./service.js";

export interface TaxOverridesModule {
  router: Router;
  service: TaxOverridesService;
}

export interface CreateTaxOverridesModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
}

/** Drizzle repo + service + router. */
export function createTaxOverridesModule(
  opts: CreateTaxOverridesModuleOptions,
): TaxOverridesModule {
  const service = new TaxOverridesService({
    repo: new DrizzleTaxOverridesRepository(opts.db),
  });
  return {
    router: createTaxOverridesRouter({ service, requireAuth: opts.requireAuth }),
    service,
  };
}

export { TaxOverridesService } from "./service.js";
export { DrizzleTaxOverridesRepository } from "./repository.drizzle.js";
export { InMemoryTaxOverridesRepository } from "./repository.memory.js";
export { createTaxOverridesRouter } from "./router.js";
export { toOverrideMap, toOverrides } from "./wire.js";
export type { TaxOverride, TaxOverrideInput, TaxOverridesRepository } from "./ports.js";
