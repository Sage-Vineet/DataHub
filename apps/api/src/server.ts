import type { Server } from "node:http";
// `Request` from express, not the global fetch `Request` — the two share a
// name, and picking the wrong one here typechecked as `any` in a test file for
// months.
import type { Request as ExpressRequest, RequestHandler } from "express";
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
import { createActivityModule } from "./modules/activity/index.js";
import { createChartOfAccountsModule } from "./modules/chart-of-accounts/index.js";
import { createGroupsModule } from "./modules/groups/index.js";
import { createWorkspaceModule } from "./modules/workspace/index.js";
import { createMessagesModule } from "./modules/messages/index.js";
import { createReportsModule } from "./modules/reports/index.js";
import { createBankReconciliationModule } from "./modules/bank-reconciliation/index.js";
import { createReportSourcesModule } from "./modules/report-sources/index.js";
import { GeminiClient } from "./shared/gemini.js";
import { createStatementsModule } from "./modules/statements/index.js";
import { createTaxOverridesModule } from "./modules/tax-overrides/index.js";
import { createQuickBooksModule } from "./modules/quickbooks/index.js";
import { createSyncModule } from "./modules/sync/index.js";
import { createDatasetsModule } from "./modules/datasets/index.js";
import { createGlImportModule } from "./modules/gl-import/index.js";
import { createQoeModule } from "./modules/qoe/index.js";
import { createDataRoomModule } from "./modules/dataroom/index.js";
import { createQaModule } from "./modules/qa/index.js";
import { createCimModule } from "./modules/cim/index.js";
import { createCoaReviewModule } from "./modules/coa-review/module.js";
import { createInProcessHierarchyWriter } from "./modules/coa-review/hierarchy.in-process.js";
import { DrizzleCimDataRoomPort, QaServiceAdapter } from "./modules/cim/adapters.js";
import { unavailableDataRoom } from "./modules/qa/repository.memory.js";
import { requireSession } from "./shared/session.js";
import { EnvConfigError, loadGatewayEnv, type GatewayEnv } from "./env.js";

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
 * Build the modules the gateway mounts.
 *
 * Every one of these was once behind a cutover flag: on served the module, off
 * fell through to the legacy backend, and flipping one was the migration
 * (ADR-0003/0007). They mount unconditionally now — the only flags left are the
 * capability switches, which subtract a feature rather than roll one back.
 *
 * Domain modules are protected by the shared Better Auth session guard.
 *
 * MOUNT PATHS ARE THE CONTRACT. `/auth`, `/companies`, `/users`, and `/` for the
 * modules that span several prefixes — because that is what the SPA calls
 * (`apps/web/src/lib/api.js`). They mirrored the legacy backend's `app.js`, which
 * is why they are NOT under `/api`: there, `/api/auth/*` belonged to the
 * QuickBooks OAuth routes, so mounting under it would have missed all real
 * traffic. That constraint outlived the backend — the SPA still calls these
 * paths, and moving them is a change to every caller.
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

function buildModules(flags: GatewayEnv["flags"]): MountedModule[] {
  const modules: MountedModule[] = [];
  // Captured so the CIM builder can reach the Q&A service through a typed port
  // rather than over HTTP — the module convention here (ADR-0004).
  let qaModule: ReturnType<typeof createQaModule> | undefined;
  const getDb = dbFactory();
  const graphEmailer = () =>
    process.env.GRAPH_TENANT_ID ? GraphEmailer.fromEnv(process.env) : new ConsoleEmailer();

  // Better Auth serves /auth (ADR-0007). This was a three-way choice between it,
  // a bespoke module kept as a rollback target, and legacy — and the other two
  // are gone, so there is nothing left to choose between.
  {
    const { router } = createBetterAuthModule({ db: getDb(), emailer: graphEmailer() });
    modules.push({ path: "/auth", router });
  }

  // Domain modules share one session guard: a Better Auth instance validates
  // sessions (ADR-0007), even if /auth itself is still legacy.
  {
    const db = getDb();
    const auth = createBetterAuth({
      db,
      emailer: graphEmailer(),
      config: loadBetterAuthConfig(process.env),
    });
    const requireAuth = requireSession(auth, new DrizzleAuthRepository(db));

    {
      // Companies provisions through the real folders service (folders-domain
      // D6). This used to depend on whether folders had been cut over yet, and
      // fell back to a basic adapter when it had not.
      const folderProvisioning = createFolderProvisioningPort(db);
      modules.push({
        path: "/companies",
        router: createCompaniesModule({ db, requireAuth, folderProvisioning }).router,
      });
      console.warn("[gateway] companies module ENABLED at /companies (in-process)");
    }
    {
      modules.push({ path: "/users", router: createUsersModule({ db, requireAuth }).router });
      console.warn("[gateway] users module ENABLED at /users (in-process)");
    }
    // Folders spans several path prefixes (companies/:id/folders, folders/:id,
    // folder-access/:id) so it mounts at the API root and only defines its own routes;
    // document sub-routes fall through to legacy. Mounted last so the more-specific
    // /companies and /users modules match first.
    {
      modules.push({ path: "/", router: createFoldersModule({ db, requireAuth }).router });
      console.warn("[gateway] folders module ENABLED at the API root (folder + access routes)");
    }
    // Uploads also spans several path prefixes (uploads, folders/:id/documents,
    // documents/:id) → mounted at the API root, only its own routes defined.
    {
      modules.push({ path: "/", router: createUploadsModule({ db, requireAuth }).router });
      console.warn("[gateway] uploads module ENABLED at the API root (upload + document routes)");
    }
    {
      modules.push({ path: "/", router: createRequestsModule({ db, requireAuth }).router });
      console.warn("[gateway] requests module ENABLED at the API root (request routes)");
    }
    {
      modules.push({ path: "/", router: createMessagesModule({ db, requireAuth }).router });
      console.warn("[gateway] messages module ENABLED at the API root (message routes)");
    }
    // Buyer groups — `/companies/:id/groups` and `/groups/*`. Distinct from the
    // message-groups the messages module serves, despite the similar paths.
    {
      modules.push({ path: "/", router: createGroupsModule({ db, requireAuth }).router });
      console.warn("[gateway] groups module ENABLED at the API root (buyer group routes)");
    }
    // The broker dashboard's cross-company feed. `/companies/:id/activity` is
    // the companies module's; this is the aggregate one.
    {
      modules.push({ path: "/", router: createActivityModule({ db, requireAuth }).router });
      console.warn("[gateway] activity module ENABLED at the API root (broker activity feed)");
    }
    // The chart of accounts: the grid, its audit trail and the hierarchy
    // vocabulary. Built here so the review module below writes through it
    // rather than over HTTP, which is what it used to do.
    const chartOfAccounts = createChartOfAccountsModule({ db, requireAuth });
    {
      modules.push({ path: "/", router: chartOfAccounts.router });
      console.warn("[gateway] chart-of-accounts module ENABLED at /key-reports/...");
    }

    // Persisted workspace UI state, and the shared CIM questionnaire.
    {
      modules.push({ path: "/", router: createWorkspaceModule({ db, requireAuth }).router });
      console.warn("[gateway] workspace module ENABLED at the API root (page state, questionnaire)");
    }
    {
      modules.push({
        path: "/",
        router: createBankReconciliationModule({ db, requireAuth }).router,
      });
    }

    {
      modules.push({ path: "/", router: createGlImportModule({ db, requireAuth }).router });
    }

    {
      modules.push({ path: "/", router: createDatasetsModule({ db, requireAuth }).router });
    }

    {
      modules.push({ path: "/", router: createSyncModule({ db, requireAuth }).router });
    }

    {
      // The token-sealing keys are derived from the application secret, so a
      // deployment without one would store tokens under an empty key — which
      // `secret-box` refuses outright rather than doing badly.
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        throw new EnvConfigError(
          "QUICKBOOKS_MODULE_ENABLED=true requires JWT_SECRET — the QuickBooks " +
            "tokens are encrypted with a key derived from it, and there is no " +
            "safe default.",
        );
      }
      modules.push({
        path: "/",
        router: createQuickBooksModule({
          db,
          requireAuth,
          secret,
          // Points at production unless told otherwise. Set to the sandbox
          // host to work against a sandbox realm, which is the only way the
          // live report path becomes exercisable.
          ...(process.env.QUICKBOOKS_API_BASE_URL
            ? { quickBooksBaseUrl: process.env.QUICKBOOKS_API_BASE_URL }
            : {}),
          // All three or none: an OAuth redirect built from a partial set
          // reaches Intuit and comes back as its error page, with no way into
          // this application from there.
          ...(process.env.QB_CLIENT_ID &&
          process.env.QB_CLIENT_SECRET &&
          process.env.QB_REDIRECT_URI
            ? {
                oauth: {
                  clientId: process.env.QB_CLIENT_ID,
                  clientSecret: process.env.QB_CLIENT_SECRET,
                  redirectUri: process.env.QB_REDIRECT_URI,
                  ...(process.env.QB_AUTHORIZE_URL
                    ? { authorizeUrl: process.env.QB_AUTHORIZE_URL }
                    : {}),
                },
              }
            : {}),
          ...(process.env.FRONTEND_URL ? { frontendUrl: process.env.FRONTEND_URL } : {}),
        }).router,
      });
      if (!process.env.QB_CLIENT_ID) {
        console.warn(
          "[gateway] QB_CLIENT_ID is not set — the QuickBooks OAuth routes will answer 503",
        );
      }
    }

    {
      // Document extraction needs a model. Where no key is configured the
      // module still serves everything else and the extraction route answers
      // 503 saying so — which is the honest answer for a deployment that does
      // not use it.
      const geminiKey = process.env.GEMINI_API_KEY;
      modules.push({
        path: "/",
        router: createStatementsModule({
          db,
          requireAuth,
          ...(geminiKey ? { reader: new GeminiClient({ apiKey: geminiKey }) } : {}),
        }).router,
      });
      if (!geminiKey) {
        console.warn(
          "[gateway] GEMINI_API_KEY is not set — tax-return extraction will answer 503",
        );
      }
    }

    {
      modules.push({ path: "/", router: createTaxOverridesModule({ db, requireAuth }).router });
    }

    {
      modules.push({ path: "/", router: createReportSourcesModule({ db, requireAuth }).router });
    }

    {
      // The same reader the statements module uses: building a version's entry
      // tables means reading its linked statements, and a server with no model
      // answers 503 naming the configuration rather than failing obscurely.
      const reportsReader = process.env.GEMINI_API_KEY;
      modules.push({
        path: "/",
        router: createReportsModule({
          db,
          requireAuth,
          ...(reportsReader ? { reader: new GeminiClient({ apiKey: reportsReader }) } : {}),
        }).router,
      });
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
        router: createCoaReviewModule({
          db,
          requireAuth,
          // In-process when the chart of accounts is served here, which removes
          // the HTTP hop to legacy without adding a second hierarchy writer:
          // this delegates to the one that owns the table. Still per request,
          // so a reviewer who cannot edit an account cannot apply a
          // recommendation to it either.
          ...(chartOfAccounts
            ? {
                hierarchyFor: (req: ExpressRequest) =>
                  createInProcessHierarchyWriter((accountId, patch) =>
                    chartOfAccounts.service.updateAccount(req.user!, accountId, patch),
                  ),
              }
            : {}),
        }).router,
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

interface ActivityCapture {
  handler: RequestHandler;
  /** Flush what is buffered on the way down instead of dropping it. */
  drain: () => Promise<void>;
}

function buildActivityCapture(enabled: boolean): ActivityCapture | undefined {
  if (!enabled) return undefined;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("ACTIVITY_LOG_ENABLED=true requires DATABASE_URL.");
  }
  const writer = new ActivityWriter(new DrizzleActivityRepository(createDb(databaseUrl)));
  console.warn("[gateway] activity capture ENABLED (tier 1: every request, both engines)");
  return {
    handler: createActivityCapture({ writer, jwtSecret: process.env.JWT_SECRET }),
    drain: () => writer.close(),
  };
}

/** How long to let in-flight requests finish before closing the socket anyway. */
const SHUTDOWN_GRACE_MS = 8_000;

/**
 * Stop cleanly on a signal.
 *
 * Node runs as PID 1 in the container, and PID 1 does not get default signal
 * dispositions: with no handler explicitly registered, SIGTERM is IGNORED
 * rather than terminating the process. Docker therefore sent SIGTERM, waited
 * its ten seconds, and SIGKILLed — so every stop of the gateway ended in exit
 * 137, which reads in `docker ps` exactly like an out-of-memory kill. It was
 * mistaken for one.
 *
 * The only SIGTERM listener that existed lived inside `buildActivityCapture`,
 * so it was registered only when `ACTIVITY_LOG_ENABLED=true` — and the demo
 * does not set it. Even when it did run it flushed the buffer and returned:
 * no `server.close()`, no `process.exit()`, and `app.listen` keeps the event
 * loop alive on its own.
 *
 * Two consequences beyond the confusing exit code. In-flight requests were
 * severed rather than drained, and the buffer flush was fired and not awaited —
 * so whether the last few activity events survived was a race against the kill.
 *
 * Registering the handler here rather than there means it exists whatever the
 * activity flag says. The grace period is deliberately shorter than Docker's
 * ten seconds, so a connection that will not close hits our timeout rather
 * than its SIGKILL.
 */
function installShutdown(server: Server, capture: ActivityCapture | undefined): void {
  let shuttingDown = false;

  const stop = (signal: string): void => {
    // A second Ctrl-C should not start a second shutdown.
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(`[gateway] ${signal} received, draining`);

    // Whatever happens, do not hang: a keep-alive connection that never closes
    // must not hold the process open past the grace period.
    const hard = setTimeout(() => {
      console.warn("[gateway] grace period elapsed, exiting with connections open");
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    hard.unref();

    server.close(() => {
      void (async () => {
        try {
          await capture?.drain();
        } catch (err) {
          console.warn(`[gateway] activity flush failed on shutdown: ${String(err)}`);
        }
        process.exit(0);
      })();
    });
  };

  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

function main(): void {
  // Validate our own env before anything else, so a mistyped cutover flag is a
  // startup error rather than a route-group that silently stayed on legacy.
  const env = loadGatewayEnv(process.env);
  const capture = buildActivityCapture(env.flags.ACTIVITY_LOG_ENABLED);
  const app = createGateway({
    modules: buildModules(env.flags),
    corsOrigins: env.corsOrigins,
    activityCapture: capture?.handler,
    features: clientFeatures(env.flags),
  });
  const port = env.port;

  const server = app.listen(port, () => {
    console.warn(`[gateway] listening on :${port} | ${buildModules(env.flags).length} modules`);
  });

  installShutdown(server, capture);
}

main();
