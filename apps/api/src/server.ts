import type { RequestHandler } from "express";
import { createDb, type Db } from "@datahub/db";
import {
  ActivityWriter,
  createActivityCapture,
  DrizzleActivityRepository,
} from "./activity/index.js";
import { createGateway, type MountedModule } from "./gateway.js";
import {
  createAuthModule,
  createBetterAuth,
  createBetterAuthModule,
  DrizzleAuthRepository,
  GraphEmailer,
  loadBetterAuthConfig,
} from "./modules/auth/index.js";
import { ConsoleEmailer } from "./modules/auth/index.js";
import { createCompaniesModule } from "./modules/companies/index.js";
import { createUsersModule } from "./modules/users/index.js";
import { createFoldersModule, createFolderProvisioningPort } from "./modules/folders/index.js";
import { createUploadsModule } from "./modules/uploads/index.js";
import { createRequestsModule } from "./modules/requests/index.js";
import { createMessagesModule } from "./modules/messages/index.js";
import { createReportsModule } from "./modules/reports/index.js";
import { createQoeModule } from "./modules/qoe/index.js";
import { requireSession } from "./shared/session.js";
import { parseRoutingTable } from "./routing.js";
import { loadGatewayEnv, type GatewayEnv } from "./env.js";

/** Lazily create a single shared Drizzle client for all in-process modules. */
function dbFactory(): () => Db {
  let db: Db | undefined;
  return () => {
    if (!db) {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new Error("An enabled in-process module requires DATABASE_URL.");
      }
      db = createDb(databaseUrl);
    }
    return db;
  };
}

/**
 * Build the in-process modules to mount ahead of the proxy. Each route-group is
 * served by exactly one engine, chosen by env (cutover/rollback = a flag, not a
 * code deploy — ADR-0003/0007):
 *   - BETTER_AUTH_ENABLED=true → Better Auth serves /auth (ADR-0007; wins if both set)
 *   - AUTH_MODULE_ENABLED=true → the bespoke module serves /auth (rollback target)
 *   - COMPANIES_MODULE_ENABLED=true → the companies module serves /companies
 *   - otherwise → the route-group falls through to legacy.
 * Domain modules are protected by the shared Better Auth session guard.
 *
 * MOUNT PATHS ARE THE LEGACY CONTRACT. These mirror `backend/src/app.js` exactly —
 * `/auth`, `/companies`, `/users`, and `/` for the modules that span several
 * prefixes — because that is what the SPA calls (`apps/web/src/lib/api.js`). They
 * are deliberately NOT under `/api`: in legacy, `/api/auth/*` belongs to the
 * QuickBooks OAuth routes (`backend/src/routes/quickbooks/token.js`), so mounting
 * there would both miss all real traffic and disturb QBO. Every module attaches its
 * middleware per-route (`withCommonMiddleware`), so undefined paths under a mount
 * fall through to the proxy untouched.
 */
function buildModules(flags: GatewayEnv["flags"]): MountedModule[] {
  const modules: MountedModule[] = [];
  const getDb = dbFactory();
  const graphEmailer = () =>
    process.env.GRAPH_TENANT_ID ? GraphEmailer.fromEnv(process.env) : new ConsoleEmailer();

  if (flags.BETTER_AUTH_ENABLED) {
    const { router } = createBetterAuthModule({ db: getDb(), emailer: graphEmailer() });
    modules.push({ path: "/auth", router });
    console.warn("[gateway] Better Auth ENABLED at /auth (in-process, ADR-0007)");
  } else if (flags.AUTH_MODULE_ENABLED) {
    const repo = new DrizzleAuthRepository(getDb());
    const { router } = createAuthModule({ repo });
    modules.push({ path: "/auth", router });
    console.warn("[gateway] bespoke auth module ENABLED at /auth (in-process)");
  }

  // Domain modules share one session guard: a Better Auth instance validates
  // sessions (ADR-0007), even if /auth itself is still legacy.
  const domainsEnabled =
    flags.COMPANIES_MODULE_ENABLED ||
    flags.USERS_MODULE_ENABLED ||
    flags.FOLDERS_MODULE_ENABLED ||
    flags.UPLOADS_MODULE_ENABLED ||
    flags.REQUESTS_MODULE_ENABLED ||
    flags.MESSAGES_MODULE_ENABLED ||
    flags.REPORTS_MODULE_ENABLED ||
    flags.QOE_MODULE_ENABLED;
  if (domainsEnabled) {
    const db = getDb();
    const auth = createBetterAuth({
      db,
      emailer: graphEmailer(),
      config: loadBetterAuthConfig(process.env),
    });
    const requireAuth = requireSession(auth, new DrizzleAuthRepository(db));

    if (flags.COMPANIES_MODULE_ENABLED) {
      // When folders is also enabled, companies provisions via the real folders
      // service (folders-domain D6) instead of its own basic adapter.
      const folderProvisioning =
        flags.FOLDERS_MODULE_ENABLED ? createFolderProvisioningPort(db) : undefined;
      modules.push({
        path: "/companies",
        router: createCompaniesModule({ db, requireAuth, folderProvisioning }).router,
      });
      console.warn("[gateway] companies module ENABLED at /companies (in-process)");
    }
    if (flags.USERS_MODULE_ENABLED) {
      modules.push({ path: "/users", router: createUsersModule({ db, requireAuth }).router });
      console.warn("[gateway] users module ENABLED at /users (in-process)");
    }
    // Folders spans several path prefixes (companies/:id/folders, folders/:id,
    // folder-access/:id) so it mounts at the API root and only defines its own routes;
    // document sub-routes fall through to legacy. Mounted last so the more-specific
    // /companies and /users modules match first.
    if (flags.FOLDERS_MODULE_ENABLED) {
      modules.push({ path: "/", router: createFoldersModule({ db, requireAuth }).router });
      console.warn("[gateway] folders module ENABLED at the API root (folder + access routes)");
    }
    // Uploads also spans several path prefixes (uploads, folders/:id/documents,
    // documents/:id) → mounted at the API root, only its own routes defined.
    if (flags.UPLOADS_MODULE_ENABLED) {
      modules.push({ path: "/", router: createUploadsModule({ db, requireAuth }).router });
      console.warn("[gateway] uploads module ENABLED at the API root (upload + document routes)");
    }
    if (flags.REQUESTS_MODULE_ENABLED) {
      modules.push({ path: "/", router: createRequestsModule({ db, requireAuth }).router });
      console.warn("[gateway] requests module ENABLED at the API root (request routes)");
    }
    if (flags.MESSAGES_MODULE_ENABLED) {
      modules.push({ path: "/", router: createMessagesModule({ db, requireAuth }).router });
      console.warn("[gateway] messages module ENABLED at the API root (message routes)");
    }
    if (flags.REPORTS_MODULE_ENABLED) {
      modules.push({ path: "/", router: createReportsModule({ db, requireAuth }).router });
      console.warn("[gateway] reports module ENABLED at the API root (key-report version lifecycle)");
    }
    // QoE serves /qoe, a prefix legacy does not define, so it adds surface
    // rather than shadowing it. QOE_DEMO_VERSION_ID swaps the Drizzle repo for
    // the anonymized walkthrough engagement (see modules/qoe/fixture.ts).
    if (flags.QOE_MODULE_ENABLED) {
      const demoVersionId = process.env.QOE_DEMO_VERSION_ID;
      const demoCompanyId = process.env.QOE_DEMO_COMPANY_ID;
      modules.push({
        path: "/",
        router: createQoeModule({
          db,
          requireAuth,
          ...(demoVersionId && demoCompanyId ? { demoVersionId, demoCompanyId } : {}),
        }).router,
      });
      console.warn("[gateway] QoE module ENABLED at /qoe (SDE/EBITDA bridge)");
    }
  }
  return modules;
}

/**
 * Tier-1 activity capture (SE-0004). Built here so the writer is a singleton for
 * the process — one buffer, one chain-head contender — and handed to the gateway
 * as a plain middleware. Disabled → `undefined`, and the request path is exactly
 * what it was before.
 */
function buildActivityCapture(enabled: boolean): RequestHandler | undefined {
  if (!enabled) return undefined;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("ACTIVITY_LOG_ENABLED=true requires DATABASE_URL.");
  }
  const writer = new ActivityWriter(new DrizzleActivityRepository(createDb(databaseUrl)));
  // Flush what is buffered on the way down instead of dropping it.
  const drain = (): void => {
    void writer.close();
  };
  process.once("SIGTERM", drain);
  process.once("SIGINT", drain);
  console.warn("[gateway] activity capture ENABLED (tier 1: every request, both engines)");
  return createActivityCapture({ writer, jwtSecret: process.env.JWT_SECRET });
}

function main(): void {
  // Validate our own env before anything else, so a mistyped cutover flag is a
  // startup error rather than a route-group that silently stayed on legacy.
  const env = loadGatewayEnv(process.env);
  const table = parseRoutingTable(process.env);
  const app = createGateway(table, {
    modules: buildModules(env.flags),
    corsOrigins: env.corsOrigins,
    activityCapture: buildActivityCapture(env.flags.ACTIVITY_LOG_ENABLED),
  });
  const port = env.port;

  app.listen(port, () => {
    const routes =
      table.routes.length > 0
        ? table.routes.map((r) => `${r.prefix} -> ${r.origin}`).join(", ")
        : "(none)";
    console.warn(
      `[gateway] listening on :${port} | default -> legacy (${table.origins.legacy}) | routes: ${routes}`,
    );
  });
}

main();
