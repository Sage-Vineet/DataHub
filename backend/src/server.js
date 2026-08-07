"use strict";

// Force IPv4 DNS resolution globally.
// Render's free tier does not support IPv6 outbound connections. Without this,
// every outgoing TCP connection (Postgres, Supabase, Graph) that resolves to an
// IPv6 address fails with ENETUNREACH.
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

require("dotenv").config();

// Validate the environment BEFORE anything else is loaded. A missing or weak
// JWT_SECRET, a wildcard CORS origin, or an unset production variable must stop
// the process here rather than degrade into an insecure default at runtime.
const { config, assertEnvironment } = require("./config/env");
assertEnvironment();

const { installProcessGuards } = require("./middleware/error");
installProcessGuards();

const logger = require("./security/logger");
const app = require("./app");
const db = require("./db");
const {
  getSharedPool,
  closeSharedPool,
  verifyConnection,
  describeSslPosture,
} = require("./db/pgPool");
const { StartupReport, runTask } = require("./startup/taskRunner");
const { SCHEMA_TASKS, applySchemaTask, verifyAuthSchema } = require("./startup/schemaTasks");
const { checkEmailHealth } = require("./services/emailService");
const { startReminderAutomation } = require("./services/requestReminderAutomationService");

const port = config.PORT;

/** Set SKIP_STARTUP_DDL=true once migrations are applied by CI instead. */
const SKIP_DDL = /^(1|true|yes)$/i.test(String(process.env.SKIP_STARTUP_DDL || ""));

/**
 * Runs every startup task and prints one consolidated report.
 *
 * ── Why the ordering matters ────────────────────────────────────────────────
 * Connectivity is verified FIRST. Previously each of the five schema tasks
 * opened its own pool and independently rediscovered the same TLS fault, so one
 * root cause produced five unrelated-looking warnings. Now, if the database is
 * unreachable, the schema tasks are skipped with that stated as the reason.
 */
async function runStartupTasks() {
  const report = new StartupReport();

  // ── 1. Database connectivity and TLS ──────────────────────────────────────
  const connection = await runTask(report, {
    name: "database connection",
    critical: true,
    retries: 3,
    skipReason: config.DATABASE_URL ? null : "DATABASE_URL not set",
    run: () => verifyConnection(getSharedPool()),
    describe: (info) => `${info.db} as ${info.usr} · ${describeSslPosture()}`,
  });

  // ── 2. Schema tasks ───────────────────────────────────────────────────────
  const skipSchema = !connection.ok
    ? connection.skipped
      ? "DATABASE_URL not set"
      : "database connection failed (see above)"
    : SKIP_DDL
      ? "SKIP_STARTUP_DDL=true — apply backend/sql/migrations/ in CI"
      : null;

  const pool = getSharedPool();
  for (const task of SCHEMA_TASKS) {
    await runTask(report, {
      name: task.name,
      // Not critical: these are idempotent conveniences and the authoritative
      // definitions live in backend/sql/migrations/. A failure here degrades a
      // feature; it does not make the API unsafe to serve.
      critical: false,
      retries: 1,
      skipReason: skipSchema,
      run: () => applySchemaTask(pool, task.sql),
    });
  }

  // ── 3. Authentication schema ──────────────────────────────────────────────
  // CRITICAL: a server that cannot authenticate anyone is not usable, even
  // though /health would happily return 200. Checked after the DDL tasks above
  // so a fresh database that just self-provisioned passes on the first boot.
  await runTask(report, {
    name: "auth schema",
    critical: true,
    retries: 0,
    skipReason: connection.ok ? null : "database connection failed (see above)",
    run: () => verifyAuthSchema(pool),
    describe: (r) => `${r.tables} tables, ${r.columns} user columns present`,
  });

  // ── 4. Field encryption ───────────────────────────────────────────────────
  await runTask(report, {
    name: "field encryption",
    critical: false, // env.js already hard-fails production on a malformed key
    retries: 0,
    run: async () => {
      const crypto = require("./security/crypto");
      if (!crypto.isEnabled) {
        throw Object.assign(new Error("DATA_ENCRYPTION_KEY is not configured"), {
          code: "NO_ENCRYPTION_KEY",
        });
      }
      // Prove the key actually works rather than merely being present.
      const probe = "startup-self-test";
      if (crypto.decrypt(crypto.encrypt(probe)) !== probe) {
        throw new Error("encryption self-test failed");
      }
      return true;
    },
    describe: () => "AES-256-GCM self-test passed",
  });

  // ── 5. Email delivery ─────────────────────────────────────────────────────
  await runTask(report, {
    name: "email (Microsoft Graph)",
    critical: false,
    retries: 1,
    run: async () => {
      const result = await checkEmailHealth();
      if (!result || result.ok !== true) {
        throw Object.assign(new Error(result?.reason || "Graph mailbox check failed"), {
          code: result?.code || "GRAPH_UNHEALTHY",
        });
      }
      return result;
    },
    describe: (result) => result.detail || "token acquired, sender mailbox reachable",
  });

  report.print();

  // In production a critical failure must stop the deploy rather than serve
  // traffic from a half-initialised process.
  if (config.IS_PRODUCTION && report.criticalFailures.length > 0) {
    logger.error("startup_aborted", {
      reason: `${report.criticalFailures.length} critical startup task(s) failed`,
    });
    await closeSharedPool();
    process.exit(1);
  }

  return report;
}

async function shutdown(signal) {
  logger.info("shutdown_signal", { reason: signal });
  await closeSharedPool();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

(async () => {
  try {
    await db.ready;

    // Listen immediately so Render's health probe succeeds before the slower
    // startup tasks finish. The tasks run behind the listener, not in front.
    app.listen(port, () => {
      logger.info("server_listening", { reason: `port ${port}` });

      runStartupTasks()
        .then((report) => {
          // Reminder automation needs its schema; only start it if that landed.
          const schemaFailed = report.entries.some(
            (entry) => entry.name === "reminder_automation_schema" && entry.status === "fail"
          );
          if (schemaFailed) {
            logger.warn("reminder_automation_not_started", {
              reason: "reminder_automation_schema task did not succeed",
            });
            return;
          }
          startReminderAutomation();
        })
        .catch((error) => {
          logger.error("startup_tasks_threw", { name: error.name, errorMessage: error.message });
        });
    });
  } catch (error) {
    logger.error("server_start_failed", { errorMessage: error.message });
    process.exit(1);
  }
})();
