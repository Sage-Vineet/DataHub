import { createDb } from "@datahub/db";
import { createGateway, type MountedModule } from "./gateway.js";
import { createAuthModule, DrizzleAuthRepository } from "./modules/auth/index.js";
import { parseRoutingTable } from "./routing.js";

/**
 * Build the in-process modules to mount ahead of the proxy. Auth is gated by
 * AUTH_MODULE_ENABLED so cutover/rollback is an env flag, not a code deploy
 * (phase-1-auth design D2). Off by default: /api/auth falls through to legacy.
 */
function buildModules(): MountedModule[] {
  const modules: MountedModule[] = [];
  if (process.env.AUTH_MODULE_ENABLED === "true") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("AUTH_MODULE_ENABLED=true requires DATABASE_URL for the auth module.");
    }
    const repo = new DrizzleAuthRepository(createDb(databaseUrl));
    const { router } = createAuthModule({ repo });
    modules.push({ path: "/api/auth", router });
    console.warn("[gateway] auth module ENABLED at /api/auth (in-process)");
  }
  return modules;
}

function main(): void {
  const table = parseRoutingTable(process.env);
  const app = createGateway(table, { modules: buildModules() });
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
