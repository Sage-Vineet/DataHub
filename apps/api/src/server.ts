import type { RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@datahub/db";
import {
  ActivityWriter,
  createActivityCapture,
  DrizzleActivityRepository,
} from "./activity/index.js";
import { createGateway, type MountedModule } from "./gateway.js";
import { clientFeatures } from "./features.js";
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
import { createDataRoomModule } from "./modules/dataroom/index.js";
import { createQaModule } from "./modules/qa/index.js";
import { createCimModule } from "./modules/cim/index.js";
import { createCoaReviewModule } from "./modules/coa-review/module.js";
import { DrizzleCimDataRoomPort, QaServiceAdapter } from "./modules/cim/adapters.js";
import { unavailableDataRoom } from "./modules/qa/repository.memory.js";
import { requireSession } from "./shared/session.js";
import { legacyAuthBridge } from "./legacy-bridge.js";
import { resolveSessionUser } from "./modules/auth/better-session.js";
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
/**
 * Where a published CIM lands in the data room.
 *
 * Prefers a folder actually named for it, then Financials, then whatever the
 * company's first folder is. Falling back rather than failing is deliberate: a
 * publish that succeeds into a slightly unexpected folder is recoverable by
 * moving the file, while one that refuses because no folder matched a name is
 * a dead end in front of whoever pressed the button.
 */
function publishFolderResolver(db: Db): (companyId: string) => Promise<string | null> {
  return async (companyId: string) => {
    const rows = await db
      .select({ id: schema.folders.id, name: schema.folders.name })
      .from(schema.folders)
      .where(eq(schema.folders.companyId, companyId));
    const byName = (needle: string) =>
      rows.find((r) => r.name.toLowerCase().includes(needle))?.id ?? null;
    return byName("cim") ?? byName("financial") ?? rows[0]?.id ?? null;
  };
}

function buildModules(flags: GatewayEnv["flags"], legacyOrigin: string): MountedModule[] {
  const modules: MountedModule[] = [];
  // Captured so the CIM builder can reach the Q&A service through a typed port
  // rather than over HTTP — the module convention here (ADR-0004).
  let qaModule: ReturnType<typeof createQaModule> | undefined;
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
    // Data room versioning, comments and chunked upload. Like QoE, it serves a
    // prefix legacy does not define, so it adds surface rather than shadowing
    // any — and, like QoE, it is deliberately absent from `moduleSurfaces()`.
    if (flags.DATAROOM_MODULE_ENABLED) {
      modules.push({
        path: "/",
        router: createDataRoomModule({
          db,
          requireAuth,
          features: {
            versions: flags.DATAROOM_VERSIONS_ENABLED,
            comments: flags.DATAROOM_COMMENTS_ENABLED,
            chunkedUpload: flags.DATAROOM_CHUNKED_UPLOAD_ENABLED,
          },
        }).router,
      });
      console.warn("[gateway] data room module ENABLED at /dataroom (versions, comments, chunked upload)");
    }
    // Deal Q&A. Greenfield — legacy serves nothing at /qa, so the flag is a kill
    // switch rather than a rollback. When the data room is off, the null
    // attachment adapter keeps every other Q&A route working.
    if (flags.QA_MODULE_ENABLED) {
      qaModule = createQaModule({
          db,
          requireAuth,
          features: {
            presentation: flags.QA_PRESENTATION_ENABLED,
            nominations: flags.QA_NOMINATIONS_ENABLED,
          },
        ...(flags.DATAROOM_MODULE_ENABLED ? {} : { dataRoom: unavailableDataRoom }),
      });
      modules.push({ path: "/", router: qaModule.router });
      console.warn("[gateway] Q&A module ENABLED at /qa (items, nomination, responses, rewordings)");
    }
    // The CIM builder sits on top of both. It reaches them through typed ports,
    // and when either is switched off the affected capability reports
    // unavailable rather than the builder failing as a whole — generation needs
    // Q&A, publication needs the data room, and everything else needs neither.
    if (flags.CIM_MODULE_ENABLED) {
      const qaService = qaModule?.service;
      modules.push({
        path: "/",
        router: createCimModule({
          db,
          requireAuth,
          ...(flags.DATAROOM_MODULE_ENABLED
            ? { dataRoom: new DrizzleCimDataRoomPort(db, publishFolderResolver(db)) }
            : {}),
          ...(qaService
            ? {
                qa: new QaServiceAdapter(qaService, (companyId, userId) => ({
                  id: userId,
                  // Always a real person: every port method now carries the id
                  // of whoever acted, so nothing here is synthesized.
                  name: "CIM",
                  email: "",
                  role: "broker",
                  company_id: companyId,
                  status: "active",
                  company_ids: [companyId],
                })),
              }
            : {}),
        }).router,
      });
      console.warn("[gateway] CIM module ENABLED at /cim (decks, guided Q&A, publish)");
    }

    // The chart-of-accounts reasonableness review. Advisory: no report engine
    // reads its output, so switching it off removes a review queue and changes
    // no figure anywhere — which is what makes it safe to leave off by default.
    //
    // Mounts whether or not GEMINI_API_KEY is set. Listing and deciding are
    // database operations; only generating needs a model, and that path is
    // fail-soft. Withholding the queue over an unused dependency would be the
    // worse trade.
    if (flags.COA_REVIEW_MODULE_ENABLED) {
      modules.push({
        path: "/",
        router: createCoaReviewModule({ db, requireAuth, legacyOrigin }).router,
      });
      const generation = process.env.GEMINI_API_KEY
        ? "generation enabled"
        : "generation unavailable (no GEMINI_API_KEY) — listing and decisions still work";
      console.warn(`[gateway] COA review module ENABLED at /key-reports/... (${generation})`);
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
/**
 * Re-sign the gateway's session into the shape legacy verifies.
 *
 * Only useful while routes remain on legacy: Better Auth sessions are opaque
 * database rows and legacy verifies HS256 JWTs, so without this every request
 * the SPA makes to an un-migrated route comes back `401 Invalid token`. See
 * legacy-bridge.ts for why this cannot manufacture an identity.
 */
function buildLegacyBridge(enabled: boolean): RequestHandler | undefined {
  if (!enabled) return undefined;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("LEGACY_AUTH_BRIDGE_ENABLED=true requires DATABASE_URL.");
  }
  const db = createDb(databaseUrl);
  const auth = createBetterAuth({
    db,
    emailer: new ConsoleEmailer(),
    config: loadBetterAuthConfig(process.env),
  });
  const repo = new DrizzleAuthRepository(db);
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("LEGACY_AUTH_BRIDGE_ENABLED=true requires JWT_SECRET (the value legacy verifies).");
  }
  console.warn("[gateway] legacy auth bridge ENABLED (re-signs sessions for un-migrated routes)");
  return legacyAuthBridge({
    resolveUser: (req) => resolveSessionUser(auth, repo, req),
    secret,
  });
}

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
  // `parseRoutingTable` refuses to return without it; the index signature on
  // `origins` is what loses that, so it is restated rather than asserted away.
  const legacyOrigin = table.origins.legacy;
  if (!legacyOrigin) throw new Error("LEGACY_ORIGIN is required.");
  const app = createGateway(table, {
    modules: buildModules(env.flags, legacyOrigin),
    corsOrigins: env.corsOrigins,
    activityCapture: buildActivityCapture(env.flags.ACTIVITY_LOG_ENABLED),
    beforeProxy: buildLegacyBridge(env.flags.LEGACY_AUTH_BRIDGE_ENABLED),
    features: clientFeatures(env.flags),
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
