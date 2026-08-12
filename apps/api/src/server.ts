import { createDb } from "@datahub/db";
import { createGateway, type MountedModule } from "./gateway.js";
import {
  createAuthModule,
  createBetterAuthModule,
  DrizzleAuthRepository,
  GraphEmailer,
} from "./modules/auth/index.js";
import { parseRoutingTable } from "./routing.js";

/**
 * Build the in-process modules to mount ahead of the proxy. `/api/auth` is
 * served by exactly one engine, chosen by env (cutover/rollback = a flag, not a
 * code deploy — ADR-0003/0007):
 *   - BETTER_AUTH_ENABLED=true → Better Auth (ADR-0007). Wins if both are set.
 *   - AUTH_MODULE_ENABLED=true → the bespoke module (rollback target).
 *   - neither → /api/auth falls through to legacy.
 * A real emailer is used when Graph is configured, else the console stub (dev).
 */
function buildModules(): MountedModule[] {
  const modules: MountedModule[] = [];

  if (process.env.BETTER_AUTH_ENABLED === "true") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("BETTER_AUTH_ENABLED=true requires DATABASE_URL for the auth module.");
    }
    const emailer = process.env.GRAPH_TENANT_ID ? GraphEmailer.fromEnv(process.env) : undefined;
    const { router } = createBetterAuthModule({ db: createDb(databaseUrl), emailer });
    modules.push({ path: "/api/auth", router });
    console.warn("[gateway] Better Auth ENABLED at /api/auth (in-process, ADR-0007)");
    return modules;
  }

  if (process.env.AUTH_MODULE_ENABLED === "true") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("AUTH_MODULE_ENABLED=true requires DATABASE_URL for the auth module.");
    }
    const repo = new DrizzleAuthRepository(createDb(databaseUrl));
    const { router } = createAuthModule({ repo });
    modules.push({ path: "/api/auth", router });
    console.warn("[gateway] bespoke auth module ENABLED at /api/auth (in-process)");
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
