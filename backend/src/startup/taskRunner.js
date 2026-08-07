"use strict";

/**
 * Startup task runner with diagnostic reporting.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Startup previously logged lines like:
 *
 *   [Startup] Could not auto-create email_verifications table: self-signed
 *   certificate in certificate chain — OTP will use in-memory fallback.
 *
 * That tells an operator what broke but not why, not whether it matters, and
 * not what to do. Worse, five separate tasks each reported the same underlying
 * TLS fault independently, so one root cause looked like five unrelated
 * problems and the actual signal was buried.
 *
 * This runner classifies the failure, reports a root cause and a concrete
 * resolution, deduplicates repeated causes, retries transient faults, and — in
 * production — refuses to continue when a task is marked critical.
 */

const logger = require("../security/logger");
const { config } = require("../config/env");

const SYMBOL = { ok: "✓", fail: "✗", warn: "!", skip: "-" };

/**
 * Maps a raw driver error onto an operator-actionable diagnosis.
 * Ordered most-specific first.
 */
const DIAGNOSES = [
  {
    match: (e) =>
      e.code === "SELF_SIGNED_CERT_IN_CHAIN" ||
      e.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      e.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
      /self.signed certificate|unable to verify/i.test(e.message || ""),
    cause: "TLS certificate verification failed — the server's CA is not trusted.",
    resolution:
      "Supabase direct connections use a private root ('Supabase Root 2021 CA') " +
      "that is not in Node's trust store. The certificate is bundled at " +
      "backend/certs/supabase-prod-ca-2021.crt and loaded automatically. If you " +
      "see this, that file is missing or its pinned fingerprint no longer matches " +
      "— restore it, or set DATABASE_CA_CERT to your provider's CA. " +
      "Do NOT set DATABASE_SSL_REJECT_UNAUTHORIZED=false.",
  },
  {
    match: (e) => e.code === "CERT_HAS_EXPIRED" || /certificate has expired/i.test(e.message || ""),
    cause: "The database server's TLS certificate has expired.",
    resolution:
      "Check the server certificate and the system clock on this host. If the " +
      "provider rotated its CA, update backend/certs/ and the pinned fingerprint " +
      "in src/db/pgPool.js.",
  },
  {
    match: (e) => e.code === "ERR_TLS_CERT_ALTNAME_INVALID",
    cause: "The certificate does not match the hostname in DATABASE_URL.",
    resolution:
      "The DATABASE_URL host does not match the certificate's SAN. Use the exact " +
      "host from your Supabase dashboard (db.<ref>.supabase.co or the pooler host).",
  },
  {
    match: (e) => e.code === "28P01" || /password authentication failed/i.test(e.message || ""),
    cause: "Database rejected the credentials.",
    resolution: "Verify the password in DATABASE_URL. Rotate it in the Supabase dashboard if unsure.",
  },
  {
    match: (e) => e.code === "3D000",
    cause: "The database named in DATABASE_URL does not exist.",
    resolution: "Correct the database name (Supabase uses /postgres).",
  },
  {
    match: (e) => e.code === "42501",
    cause: "The connecting role lacks privileges for this statement.",
    resolution:
      "DDL requires an owner-level role. Connect as the `postgres` user, or run " +
      "the migration from backend/sql/migrations/ via the Supabase SQL editor.",
  },
  {
    match: (e) => e.code === "42P01",
    cause: "A table this statement depends on does not exist yet.",
    resolution:
      "A prerequisite migration has not run. Apply backend/sql/migrations/ in " +
      "numeric order before starting the server.",
  },
  {
    match: (e) => e.code === "ENOTFOUND" || e.code === "EAI_AGAIN",
    cause: "DNS lookup for the database host failed.",
    resolution: "Check the hostname in DATABASE_URL and this host's DNS/network access.",
  },
  {
    match: (e) => e.code === "ECONNREFUSED",
    cause: "The database refused the TCP connection.",
    resolution:
      "Check the port (Supabase direct = 5432, Supavisor pooler = 6543) and any " +
      "firewall or egress rules between this host and the database.",
  },
  {
    match: (e) => e.code === "ETIMEDOUT" || /timeout/i.test(e.message || ""),
    cause: "The connection attempt timed out.",
    resolution:
      "Usually a firewall, an IPv6-only route, or a paused Supabase project. " +
      "Confirm the project is active and outbound 5432/6543 is permitted.",
  },
  {
    match: (e) => e.code === "NO_DSN",
    cause: "DATABASE_URL is not configured.",
    resolution: "Set DATABASE_URL in backend/.env (see backend/.env.example).",
  },
  {
    match: (e) => e.code === "AUTH_SCHEMA_MISSING",
    cause:
      "The authentication schema is not present — LOGIN WILL FAIL for every " +
      "user with 503 AUTH_STORE_UNAVAILABLE, which the browser reports as a " +
      "bare 'Failed to fetch'.",
    resolution:
      "Apply migration 089:  node scripts/apply-migration.js " +
      "089_security_sessions_and_audit.sql  (or paste it into the Supabase SQL " +
      "editor). It is additive and idempotent — safe to re-run.",
  },
  {
    match: (e) => e.code === "NO_ENCRYPTION_KEY",
    cause: "DATA_ENCRYPTION_KEY is not set — at-rest field encryption is inactive.",
    resolution:
      "Generate one with `openssl rand -base64 32` and set DATA_ENCRYPTION_KEY " +
      "in backend/.env. Until then, columns intended to hold ciphertext " +
      "(OAuth refresh tokens, banking identifiers) cannot be encrypted.",
  },
  {
    // Kept for the case where a Graph call genuinely returns 403 at runtime.
    // NOTE: an empty `roles` claim alone is NOT treated as a failure — send
    // capability is often granted via Exchange RBAC or a directory role, which
    // never appear in the token. See checkEmailHealth() for the reasoning.
    match: (e) => e.code === "GRAPH_FORBIDDEN",
    cause: "Microsoft Graph rejected the request with 403 Access is denied.",
    resolution:
      "The app cannot act on this mailbox. Grant Microsoft Graph → Application " +
      "permissions → Mail.Send and admin-consent it (Delegated will not work), " +
      "or add an Exchange RBAC assignment. Confirm with: " +
      "npm run verify:graph -- --send you@example.com",
  },
  {
    match: (e) => e.code === "GRAPH_AUTH_FAILED",
    cause: "Could not obtain a Microsoft Graph access token.",
    resolution:
      "Check GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET. A client " +
      "secret that has expired is the most common cause — check the app " +
      "registration's Certificates & secrets blade.",
  },
  {
    match: (e) => e.code === "GRAPH_NOT_CONFIGURED",
    cause: "Microsoft Graph email is not configured.",
    resolution:
      "Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and " +
      "GRAPH_SENDER_EMAIL in backend/.env. Email delivery is disabled until then.",
  },
];

function diagnose(error) {
  for (const entry of DIAGNOSES) {
    try {
      if (entry.match(error)) return { cause: entry.cause, resolution: entry.resolution };
    } catch { /* a matcher must never mask the original error */ }
  }
  return {
    cause: error.message || String(error),
    resolution: "No specific remedy known — see the stack trace in the logs.",
  };
}

/** Faults worth retrying: transient network and connection-level problems. */
const RETRYABLE = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "EPIPE",
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now — server still starting
  "53300", // too_many_connections
]);

function isRetryable(error) {
  return RETRYABLE.has(error.code);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class StartupReport {
  constructor() {
    this.entries = [];
    this.startedAt = Date.now();
  }

  add(entry) {
    this.entries.push(entry);
  }

  get failed() {
    return this.entries.filter((e) => e.status === "fail");
  }

  get criticalFailures() {
    return this.entries.filter((e) => e.status === "fail" && e.critical);
  }

  /**
   * Prints a single consolidated report.
   *
   * Identical root causes are grouped, so one TLS misconfiguration reads as one
   * problem affecting five tasks rather than five separate mysteries.
   */
  print() {
    const width = Math.max(...this.entries.map((e) => e.name.length), 20);
    const lines = ["", "  Startup tasks", "  " + "-".repeat(width + 34)];

    for (const entry of this.entries) {
      const symbol = SYMBOL[entry.status] || "?";
      const detail = entry.detail ? `  ${entry.detail}` : "";
      const timing = entry.ms !== undefined ? ` (${entry.ms}ms)` : "";
      lines.push(`  ${symbol} ${entry.name.padEnd(width)}  ${entry.summary}${detail}${timing}`);
    }

    const failures = this.failed;
    if (failures.length > 0) {
      // Group by root cause.
      const byCause = new Map();
      for (const entry of failures) {
        const key = entry.cause;
        if (!byCause.has(key)) byCause.set(key, { resolution: entry.resolution, tasks: [] });
        byCause.get(key).tasks.push(entry.name);
      }

      lines.push("", `  ${failures.length} task(s) failed across ${byCause.size} root cause(s):`);
      let index = 1;
      for (const [cause, info] of byCause) {
        lines.push("");
        lines.push(`  [${index}] Affected  : ${info.tasks.join(", ")}`);
        lines.push(`      Root cause: ${cause}`);
        lines.push(`      Resolution: ${wrap(info.resolution, 74, "                  ")}`);
        index += 1;
      }
    }

    lines.push("", `  Completed in ${Date.now() - this.startedAt}ms`, "");
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  }
}

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = "";
  for (const word of words) {
    if ((line + word).length > width) {
      out.push(line.trimEnd());
      line = "";
    }
    line += `${word} `;
  }
  if (line.trim()) out.push(line.trimEnd());
  return out.join(`\n${indent}`);
}

/**
 * Runs a startup task with retries and structured reporting.
 *
 * @param {StartupReport} report
 * @param {object} task
 * @param {string} task.name
 * @param {() => Promise<any>} task.run
 * @param {boolean} [task.critical=false]  in production, a critical failure exits
 * @param {number}  [task.retries=2]
 * @param {string}  [task.skipReason]      when set, the task is skipped
 * @param {(result:any) => string} [task.describe]
 */
async function runTask(report, task) {
  const { name, run, critical = false, retries = 2, skipReason = null, describe } = task;

  if (skipReason) {
    report.add({ name, status: "skip", summary: "SKIPPED", detail: skipReason, critical: false });
    return { ok: false, skipped: true };
  }

  const startedAt = Date.now();
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await run();
      report.add({
        name,
        status: "ok",
        summary: "OK",
        detail: describe ? describe(result) : "",
        ms: Date.now() - startedAt,
        critical,
      });
      return { ok: true, result };
    } catch (error) {
      lastError = error;
      if (attempt < retries && isRetryable(error)) {
        // Exponential backoff: 250ms, 500ms, 1s…
        const delay = 250 * 2 ** attempt;
        logger.warn("startup_task_retry", {
          reason: `${name}: ${error.code || error.name}, retrying in ${delay}ms`,
        });
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  const { cause, resolution } = diagnose(lastError);
  report.add({
    name,
    status: "fail",
    summary: "FAILED",
    detail: lastError.code ? `[${lastError.code}]` : "",
    ms: Date.now() - startedAt,
    cause,
    resolution,
    critical,
  });

  // A stack trace is only informative when we could NOT diagnose the fault.
  // For a recognised cause the trace just points at this runner, and printing
  // it ahead of the report buries the actionable resolution in noise.
  const diagnosed = DIAGNOSES.some((entry) => {
    try {
      return entry.match(lastError);
    } catch {
      return false;
    }
  });

  logger.error("startup_task_failed", {
    reason: `${name}: ${cause}`,
    errorCode: lastError.code,
    ...(diagnosed || config.IS_PRODUCTION ? {} : { stack: lastError.stack }),
  });

  return { ok: false, error: lastError };
}

module.exports = { StartupReport, runTask, diagnose, isRetryable };
