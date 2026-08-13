import { createDb, type Db } from "@datahub/db";
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
import { requireSession } from "./shared/session.js";
import { parseRoutingTable } from "./routing.js";

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
 * Build the in-process modules to mount ahead of the proxy. Each `/api/*`
 * route-group is served by exactly one engine, chosen by env (cutover/rollback =
 * a flag, not a code deploy — ADR-0003/0007):
 *   - BETTER_AUTH_ENABLED=true → Better Auth serves /api/auth (ADR-0007; wins if both set)
 *   - AUTH_MODULE_ENABLED=true → the bespoke module serves /api/auth (rollback target)
 *   - COMPANIES_MODULE_ENABLED=true → the companies module serves /api/companies
 *   - otherwise → the route-group falls through to legacy.
 * Domain modules are protected by the shared Better Auth session guard.
 */
function buildModules(): MountedModule[] {
  const modules: MountedModule[] = [];
  const getDb = dbFactory();
  const graphEmailer = () =>
    process.env.GRAPH_TENANT_ID ? GraphEmailer.fromEnv(process.env) : new ConsoleEmailer();

  if (process.env.BETTER_AUTH_ENABLED === "true") {
    const { router } = createBetterAuthModule({ db: getDb(), emailer: graphEmailer() });
    modules.push({ path: "/api/auth", router });
    console.warn("[gateway] Better Auth ENABLED at /api/auth (in-process, ADR-0007)");
  } else if (process.env.AUTH_MODULE_ENABLED === "true") {
    const repo = new DrizzleAuthRepository(getDb());
    const { router } = createAuthModule({ repo });
    modules.push({ path: "/api/auth", router });
    console.warn("[gateway] bespoke auth module ENABLED at /api/auth (in-process)");
  }

  // Domain modules share one session guard: a Better Auth instance validates
  // sessions (ADR-0007), even if /api/auth itself is still legacy.
  const domainsEnabled =
    process.env.COMPANIES_MODULE_ENABLED === "true" ||
    process.env.USERS_MODULE_ENABLED === "true" ||
    process.env.FOLDERS_MODULE_ENABLED === "true" ||
    process.env.UPLOADS_MODULE_ENABLED === "true";
  if (domainsEnabled) {
    const db = getDb();
    const auth = createBetterAuth({
      db,
      emailer: graphEmailer(),
      config: loadBetterAuthConfig(process.env),
    });
    const requireAuth = requireSession(auth, new DrizzleAuthRepository(db));

    if (process.env.COMPANIES_MODULE_ENABLED === "true") {
      // When folders is also enabled, companies provisions via the real folders
      // service (folders-domain D6) instead of its own basic adapter.
      const folderProvisioning =
        process.env.FOLDERS_MODULE_ENABLED === "true" ? createFolderProvisioningPort(db) : undefined;
      modules.push({
        path: "/api/companies",
        router: createCompaniesModule({ db, requireAuth, folderProvisioning }).router,
      });
      console.warn("[gateway] companies module ENABLED at /api/companies (in-process)");
    }
    if (process.env.USERS_MODULE_ENABLED === "true") {
      modules.push({ path: "/api/users", router: createUsersModule({ db, requireAuth }).router });
      console.warn("[gateway] users module ENABLED at /api/users (in-process)");
    }
    // Folders spans several path prefixes (companies/:id/folders, folders/:id,
    // folder-access/:id) so it mounts under /api and only defines its own routes;
    // document sub-routes fall through to legacy. Mounted last so the more-specific
    // /api/companies and /api/users modules match first.
    if (process.env.FOLDERS_MODULE_ENABLED === "true") {
      modules.push({ path: "/api", router: createFoldersModule({ db, requireAuth }).router });
      console.warn("[gateway] folders module ENABLED under /api (folder + access routes)");
    }
    // Uploads also spans several path prefixes (uploads, folders/:id/documents,
    // documents/:id) → mounted under /api, only its own routes defined.
    if (process.env.UPLOADS_MODULE_ENABLED === "true") {
      modules.push({ path: "/api", router: createUploadsModule({ db, requireAuth }).router });
      console.warn("[gateway] uploads module ENABLED under /api (upload + document routes)");
    }
  }
  return modules;
}

function main(): void {
  const table = parseRoutingTable(process.env);
  const corsOrigins = (process.env.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const app = createGateway(table, { modules: buildModules(), corsOrigins });
  const port = Number(process.env.PORT ?? 8080);

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
