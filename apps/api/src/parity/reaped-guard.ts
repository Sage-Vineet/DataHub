import { EnvConfigError, type ModuleFlag } from "../env.js";
import { moduleSurfaces, reapedRoutes, routerRoutes } from "./routes.js";

/**
 * A reaped route has no legacy fallback, so its module's flag is no longer a
 * choice.
 *
 * `env.ts` documents unset as the safe default — "fall through to legacy". That
 * was true while legacy still served everything. It stops being true the moment
 * a legacy handler is deleted: the flag is off, the module is not mounted, the
 * proxy has nothing to forward to, and the route 404s. Nothing in the boot
 * sequence notices, because a flag that is off looks exactly like a cutover
 * that has not happened yet.
 *
 * So the same rule the flag parser already applies to a malformed value applies
 * here: refuse to start, and name what to fix. A domain whose routes have been
 * reaped must have its module enabled.
 */

/** Which flag governs each module surface. */
const FLAG_OF_DOMAIN: Record<string, ModuleFlag> = {
  companies: "COMPANIES_MODULE_ENABLED",
  users: "USERS_MODULE_ENABLED",
  folders: "FOLDERS_MODULE_ENABLED",
  uploads: "UPLOADS_MODULE_ENABLED",
  requests: "REQUESTS_MODULE_ENABLED",
  messages: "MESSAGES_MODULE_ENABLED",
  groups: "GROUPS_MODULE_ENABLED",
  activity: "ACTIVITY_MODULE_ENABLED",
  workspace: "WORKSPACE_MODULE_ENABLED",
  chartOfAccounts: "CHART_OF_ACCOUNTS_MODULE_ENABLED",
  reports: "REPORTS_MODULE_ENABLED",
  bankReconciliation: "BANK_RECONCILIATION_MODULE_ENABLED",
  reportSources: "REPORT_SOURCES_MODULE_ENABLED",
  statements: "STATEMENTS_MODULE_ENABLED",
  quickbooks: "QUICKBOOKS_MODULE_ENABLED",
  sync: "SYNC_MODULE_ENABLED",
};

export interface ReapedGap {
  domain: string;
  flag: ModuleFlag;
  /** The routes that would 404, worst-first by nothing in particular — sorted. */
  routes: string[];
}

/**
 * Which disabled modules own routes legacy no longer serves.
 *
 * Returns the gaps rather than throwing, so a caller can report all of them at
 * once instead of one flag per restart.
 */
export function reapedGaps(flags: Readonly<Record<ModuleFlag, boolean>>): ReapedGap[] {
  const reaped = reapedRoutes();
  if (reaped.size === 0) return [];

  const gaps: ReapedGap[] = [];
  for (const module of moduleSurfaces()) {
    const flag = FLAG_OF_DOMAIN[module.name];
    // A module with no flag in the map is not flag-gated; nothing to check.
    if (!flag || flags[flag]) continue;

    const orphaned = routerRoutes(module.router, module.mount)
      .filter((route) => reaped.has(route))
      .sort();
    if (orphaned.length > 0) gaps.push({ domain: module.name, flag, routes: orphaned });
  }
  return gaps;
}

export function assertReapedModulesEnabled(
  flags: Readonly<Record<ModuleFlag, boolean>>,
): void {
  const gaps = reapedGaps(flags);
  if (gaps.length === 0) return;

  const detail = gaps
    .map(({ flag, routes }) => {
      // Naming a few is enough to recognise the domain; naming ninety is not.
      const shown = routes.slice(0, 3).join(", ");
      const rest = routes.length > 3 ? `, and ${routes.length - 3} more` : "";
      return `  ${flag}=true — legacy no longer serves ${shown}${rest}`;
    })
    .join("\n");

  throw new EnvConfigError(
    `These modules own routes that legacy has already been reaped of, so leaving ` +
      `them off would 404 rather than fall through:\n${detail}\n` +
      `Refusing to start rather than serve a surface with holes in it.`,
  );
}
