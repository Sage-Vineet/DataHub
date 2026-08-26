import type { RequestHandler, Router } from "express";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { ForbiddenError } from "../../shared/errors.js";
import { DrizzleChartOfAccountsGenerator } from "./regenerate.drizzle.js";
import { DrizzleChartOfAccountsRepository } from "./repository.drizzle.js";
import { createChartOfAccountsRouter } from "./router.js";
import { ChartOfAccountsService, type VersionAccessPort } from "./service.js";

export interface ChartOfAccountsModule {
  router: Router;
  service: ChartOfAccountsService;
}

export interface CreateChartOfAccountsModuleOptions {
  db: Db;
  /** The shared session guard (Better Auth) — populates `req.user`. */
  requireAuth: RequestHandler;
}

/**
 * Version access over Drizzle.
 *
 * A chart of accounts belongs to a report version, which belongs to a company —
 * so authorization is the company's, resolved through the version.
 */
export class DrizzleVersionAccessPort implements VersionAccessPort {
  constructor(private readonly db: Db) {}

  async companyIdFor(versionId: string): Promise<string | null> {
    const rows = await this.db
      .select({ companyId: schema.keyReportVersions.companyId })
      .from(schema.keyReportVersions)
      .where(eq(schema.keyReportVersions.id, versionId))
      .limit(1);
    return rows[0]?.companyId ?? null;
  }

  assertAccess(user: SessionUser, companyId: string): void {
    if (!canAccessCompany(user, companyId)) {
      throw new ForbiddenError("You do not have permission to access this company's reports.");
    }
  }
}

/** Compose the chart-of-accounts module. */
export function createChartOfAccountsModule(
  opts: CreateChartOfAccountsModuleOptions,
): ChartOfAccountsModule {
  const service = new ChartOfAccountsService({
    repo: new DrizzleChartOfAccountsRepository(opts.db),
    versions: new DrizzleVersionAccessPort(opts.db),
    generator: new DrizzleChartOfAccountsGenerator(opts.db),
  });
  return {
    router: createChartOfAccountsRouter({ service, requireAuth: opts.requireAuth }),
    service,
  };
}

export { ChartOfAccountsService } from "./service.js";
export type { VersionAccessPort, ChartOfAccountsResponse } from "./service.js";
export { DrizzleChartOfAccountsRepository } from "./repository.drizzle.js";
export { InMemoryChartOfAccountsRepository } from "./repository.memory.js";
export { createChartOfAccountsRouter, readPatch } from "./router.js";
export {
  buildTree,
  columnsToLevels,
  levelsToColumns,
  hierarchySnapshot,
  isModified,
  statementTypeFor,
  toAccount,
  MAX_LEVELS,
} from "./mapping.js";
export type { CoaAccount, CoaRow, CoaTreeNode } from "./mapping.js";
export type { AccountPatch, ChartOfAccountsRepository, HierarchyLevel } from "./ports.js";

export { DrizzleChartOfAccountsGenerator } from "./regenerate.drizzle.js";
export {
  accountKeyOf,
  buildChartOfAccounts,
  isNonAccountRow,
  nameKeyOf,
} from "./generate.js";
export type { GeneratedAccount, SourceAccountRow } from "./generate.js";
