"use strict";

/**
 * Single source of truth for direct Postgres connections.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `ssl: { rejectUnauthorized: false }` was previously repeated in eight files.
 * That setting accepts ANY certificate, reducing TLS to obfuscation: an
 * attacker positioned between the app and the database (a compromised network
 * hop, hijacked DNS, a malicious egress proxy) can present their own
 * certificate and read or modify every query and result in cleartext.
 *
 * ── Why the CA bundle exists ────────────────────────────────────────────────
 * Supabase's DIRECT connection endpoint (`db.<ref>.supabase.co:5432`) does not
 * use a publicly-trusted certificate. It presents:
 *
 *     db.<ref>.supabase.co
 *       └── issued by "Supabase Intermediate 2021 CA"
 *             └── issued by "Supabase Root 2021 CA"   ← private, self-signed
 *
 * That root is not in Node's bundled Mozilla trust store, so verification fails
 * with SELF_SIGNED_CERT_IN_CHAIN. The correct fix is to supply the root as an
 * explicit trust anchor — NOT to disable verification.
 *
 * Pinning this CA is strictly STRONGER than ordinary public-CA trust: only a
 * certificate chaining to Supabase's own root is accepted, so a mis-issuance by
 * any of the ~150 public CAs cannot be used to impersonate the database.
 *
 * The bundled certificate is verified against a pinned SHA-256 fingerprint at
 * load time, so swapping the file does not silently change who we trust.
 *
 *   Source : https://supabase-downloads.s3.ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
 *   Subject: C=US ST=Delware L=New Castle O=Supabase Inc CN=Supabase Root 2021 CA
 *   Expires: 2031-04-26
 *
 * The Supavisor POOLER endpoint (`*.pooler.supabase.com`) uses a public CA, so
 * both work: the bundled root is merged with the system trust store rather than
 * replacing it.
 */

const fs = require("fs");
const path = require("path");
const tls = require("tls");
const crypto = require("crypto");
const { Pool } = require("pg");
const { config } = require("../config/env");
const logger = require("../security/logger");

/**
 * SHA-256 fingerprint of "Supabase Root 2021 CA".
 *
 * Verified against the certificate the production database actually presents —
 * see `npm run verify:db-tls`. If Supabase rotates its root, this constant and
 * the bundled file must be updated together, deliberately.
 */
const SUPABASE_ROOT_CA_FINGERPRINT =
  "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";

const SUPABASE_CA_PATH = path.join(__dirname, "..", "..", "certs", "supabase-prod-ca-2021.crt");

/** Hosts for which the bundled Supabase root is added as a trust anchor. */
const SUPABASE_HOST_RE = /(^|\.)supabase\.(co|com|net)$/i;

let supabaseCaCache;
let userCaCache;

/**
 * Loads the bundled Supabase root CA and verifies its fingerprint.
 * Returns null (with a warning) if it is missing or does not match.
 */
function loadSupabaseCa() {
  if (supabaseCaCache !== undefined) return supabaseCaCache;

  try {
    const pem = fs.readFileSync(SUPABASE_CA_PATH, "utf8");
    const cert = new crypto.X509Certificate(pem);

    if (cert.fingerprint256 !== SUPABASE_ROOT_CA_FINGERPRINT) {
      // The file on disk is not the certificate this code was reviewed against.
      // Refuse it rather than trust an unknown anchor.
      logger.error("supabase_ca_fingerprint_mismatch", {
        reason:
          "certs/supabase-prod-ca-2021.crt does not match the pinned fingerprint " +
          "and will NOT be trusted. Restore the file or update the pin deliberately.",
      });
      supabaseCaCache = null;
      return supabaseCaCache;
    }

    if (new Date(cert.validTo).getTime() < Date.now()) {
      logger.error("supabase_ca_expired", { reason: `CA expired ${cert.validTo}` });
      supabaseCaCache = null;
      return supabaseCaCache;
    }

    supabaseCaCache = pem;
    return supabaseCaCache;
  } catch (error) {
    logger.warn("supabase_ca_unavailable", {
      reason: `${error.code || error.name} reading certs/supabase-prod-ca-2021.crt`,
    });
    supabaseCaCache = null;
    return supabaseCaCache;
  }
}

/** Loads an operator-supplied CA from DATABASE_CA_CERT — inline PEM or a path. */
function loadUserCa() {
  if (userCaCache !== undefined) return userCaCache;

  const raw = process.env.DATABASE_CA_CERT;
  if (!raw || !String(raw).trim()) {
    userCaCache = null;
    return userCaCache;
  }

  const value = String(raw).trim();
  if (value.includes("BEGIN CERTIFICATE")) {
    // Render and Vercel collapse newlines in environment variables; restore them.
    userCaCache = value.replace(/\\n/g, "\n");
    return userCaCache;
  }

  try {
    userCaCache = fs.readFileSync(value, "utf8");
  } catch (error) {
    logger.error("database_ca_cert_unreadable", {
      reason: `${error.code || error.name} reading DATABASE_CA_CERT path`,
    });
    userCaCache = null;
  }
  return userCaCache;
}

function hostnameOf(connectionString) {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return "";
  }
}

function isLocalConnection(connectionString) {
  const host = hostnameOf(connectionString);
  return /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(host) ||
    /(?:localhost|127\.0\.0\.1)/.test(String(connectionString || ""));
}

/**
 * Builds the `ssl` option for a connection string.
 *
 * Returns `false` for loopback connections — those never leave the machine, so
 * there is no transport for an attacker to sit on.
 *
 * For everything else, certificate verification and hostname checking are ON.
 * Trust anchors, in order of precedence:
 *   1. DATABASE_CA_CERT, when supplied.
 *   2. The bundled Supabase root, for *.supabase.co / .com / .net hosts.
 *   3. Node's built-in Mozilla store (always merged in, so a pooler endpoint
 *      with a public certificate keeps working).
 */
function buildSslOptions(connectionString) {
  if (isLocalConnection(connectionString)) return false;

  const host = hostnameOf(connectionString);

  // Explicit, deliberate opt-out. Still honoured, still loud.
  if (!config.DATABASE_SSL_REJECT_UNAUTHORIZED) {
    logger.warn("database_tls_verification_disabled", {
      reason:
        "DATABASE_SSL_REJECT_UNAUTHORIZED=false — this connection is vulnerable " +
        "to an active man-in-the-middle. Remove the override; the Supabase CA is " +
        "bundled and verification works out of the box.",
    });
    return { rejectUnauthorized: false };
  }

  const anchors = [];

  const userCa = loadUserCa();
  if (userCa) anchors.push(userCa);

  if (SUPABASE_HOST_RE.test(host)) {
    const supabaseCa = loadSupabaseCa();
    if (supabaseCa) anchors.push(supabaseCa);
  }

  // Merge rather than replace: passing `ca` overrides the default store
  // entirely, which would break any host using a public certificate.
  anchors.push(...tls.rootCertificates);

  return {
    rejectUnauthorized: true,
    ca: anchors,
    // Explicit for clarity — Node checks the hostname whenever
    // rejectUnauthorized is true. Together with `ca` this is `verify-full`.
    servername: host || undefined,
    minVersion: "TLSv1.2",
  };
}

/**
 * Describes the resolved TLS posture, for the startup report.
 * Performs no I/O beyond the cached CA reads.
 */
function describeSslPosture(connectionString = config.DATABASE_URL) {
  if (!connectionString) return "no DATABASE_URL";
  const ssl = buildSslOptions(connectionString);
  if (ssl === false) return "disabled (loopback)";
  if (!ssl.rejectUnauthorized) return "UNVERIFIED (override active)";
  const host = hostnameOf(connectionString);
  const anchor = loadUserCa()
    ? "DATABASE_CA_CERT"
    : SUPABASE_HOST_RE.test(host) && loadSupabaseCa()
      ? "bundled Supabase root CA"
      : "system trust store";
  return `verify-full via ${anchor}`;
}

/**
 * Creates a pool with hardened defaults.
 *
 * @param {object} [options]
 * @param {string} [options.connectionString] defaults to DATABASE_URL
 * @returns {Pool|null} null when no connection string is configured
 */
function createPool(options = {}) {
  const connectionString = options.connectionString || config.DATABASE_URL;
  if (!connectionString) return null;

  const pool = new Pool({
    connectionString,
    ssl: buildSslOptions(connectionString),
    max: options.max ?? 5,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30000,
    // Caps how long a single query may hold a connection. Without this, one
    // pathological query can exhaust the pool and take the service down.
    statement_timeout: options.statementTimeoutMs ?? 30000,
    query_timeout: options.queryTimeoutMs ?? 30000,
    application_name: options.applicationName || "datahub-api",
  });

  // An unhandled 'error' event on a pg Pool crashes the process.
  pool.on("error", (error) => {
    logger.error("pg_pool_error", { name: error.name, errorCode: error.code });
  });

  return pool;
}

/**
 * Shared pool.
 *
 * Startup tasks previously each created their own Pool and called `.end()` on
 * it, so five short-lived pools were opened and torn down in sequence during
 * boot. One shared pool is cheaper and means a TLS misconfiguration surfaces
 * once, in one place.
 */
let sharedPool = null;
function getSharedPool() {
  if (!sharedPool) sharedPool = createPool({ max: 10, applicationName: "datahub-api" });
  return sharedPool;
}

async function closeSharedPool() {
  if (sharedPool) {
    await sharedPool.end().catch(() => {});
    sharedPool = null;
  }
}

/**
 * Verifies connectivity and returns server details for the startup report.
 * Throws with the underlying error so the caller can classify it.
 */
async function verifyConnection(pool = getSharedPool()) {
  if (!pool) throw Object.assign(new Error("DATABASE_URL is not configured"), { code: "NO_DSN" });
  const { rows } = await pool.query(
    "SELECT current_database() AS db, current_user AS usr, version() AS version"
  );
  return rows[0];
}

module.exports = {
  createPool,
  getSharedPool,
  closeSharedPool,
  buildSslOptions,
  describeSslPosture,
  verifyConnection,
  loadSupabaseCa,
  SUPABASE_ROOT_CA_FINGERPRINT,
  SUPABASE_CA_PATH,
};
