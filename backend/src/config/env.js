"use strict";

/**
 * Startup environment validation — fail fast, fail loud.
 *
 * WHY: A missing or weak secret must never degrade silently into an insecure
 * default. The historical `process.env.JWT_SECRET || "change_me"` pattern meant
 * a misconfigured production deploy would happily sign and accept tokens under
 * a publicly known key — a total authentication bypass. This module makes the
 * process refuse to boot instead.
 *
 * Load this BEFORE anything else in server.js.
 */

require("dotenv").config();

const crypto = require("crypto");

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const IS_TEST = NODE_ENV === "test";

const errors = [];
const warnings = [];

/** Minimum entropy for any signing/encryption secret, in characters. */
const MIN_SECRET_LENGTH = 32;

/** Secrets that must never be accepted, regardless of length. */
const FORBIDDEN_SECRETS = new Set([
  "change_me",
  "changeme",
  "secret",
  "your_jwt_secret_here",
  "your_secret_here",
  "development",
  "test",
  "password",
]);

function requireVar(name, { minLength = 0, productionOnly = false } = {}) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    if (productionOnly && !IS_PRODUCTION) {
      warnings.push(`${name} is not set (required in production).`);
      return null;
    }
    errors.push(`${name} is required but not set.`);
    return null;
  }
  const trimmed = String(value).trim();
  if (minLength && trimmed.length < minLength) {
    errors.push(`${name} must be at least ${minLength} characters (got ${trimmed.length}).`);
    return null;
  }
  return trimmed;
}

function requireSecret(name, { productionOnly = false } = {}) {
  const value = requireVar(name, { minLength: MIN_SECRET_LENGTH, productionOnly });
  if (!value) return null;
  if (FORBIDDEN_SECRETS.has(value.toLowerCase())) {
    errors.push(`${name} is set to a well-known placeholder value and must be replaced.`);
    return null;
  }
  // Reject secrets with trivially low character diversity (e.g. "aaaa...").
  if (new Set(value).size < 8) {
    errors.push(`${name} has insufficient entropy — use a random 32+ byte value.`);
    return null;
  }
  return value;
}

function intVar(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed)) {
    errors.push(`${name} must be an integer (got "${raw}").`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    errors.push(`${name} must be between ${min} and ${max} (got ${parsed}).`);
    return fallback;
  }
  return parsed;
}

function boolVar(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function listVar(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// ── Core secrets ─────────────────────────────────────────────────────────────
// In non-production we generate ephemeral secrets so a fresh clone can boot,
// but they are regenerated on every restart (all sessions die on reload) and a
// loud warning is printed. Production always requires explicit values.

function devFallbackSecret(name) {
  if (IS_PRODUCTION) return null;
  const generated = crypto.randomBytes(48).toString("base64url");
  warnings.push(
    `${name} not set — generated an ephemeral development secret. ` +
      "All sessions will be invalidated on restart. Set it in .env for stable local auth."
  );
  return generated;
}

const JWT_SECRET =
  requireSecret("JWT_SECRET", { productionOnly: true }) || devFallbackSecret("JWT_SECRET");

const JWT_REFRESH_SECRET =
  requireSecret("JWT_REFRESH_SECRET", { productionOnly: true }) ||
  devFallbackSecret("JWT_REFRESH_SECRET");

// Access and refresh tokens MUST be signed with different keys so that a token
// of one type can never be replayed as the other.
if (JWT_SECRET && JWT_REFRESH_SECRET && JWT_SECRET === JWT_REFRESH_SECRET) {
  errors.push("JWT_SECRET and JWT_REFRESH_SECRET must be different values.");
}

/**
 * 32-byte key for AES-256-GCM field encryption, supplied as base64 or hex.
 *
 * Production: a missing or malformed key is a HARD FAILURE. Booting without it
 * means columns that are supposed to hold ciphertext quietly receive plaintext
 * — the encryption is "enabled" in the architecture diagram and absent in the
 * database, which is the worst of both worlds. Encryption is never silently
 * disabled.
 *
 * Development: warn and continue, so a fresh clone runs without ceremony.
 * A MALFORMED key still fails everywhere: a wrong-length key is a
 * configuration error in any environment, and accepting it would defer a
 * crash to the first encrypt() call at runtime.
 */
function parseEncryptionKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY;

  if (!raw || !String(raw).trim()) {
    if (IS_PRODUCTION) {
      errors.push(
        "DATA_ENCRYPTION_KEY is required in production — at-rest field encryption " +
          "must not be silently disabled. Generate one with: openssl rand -base64 32"
      );
    } else {
      warnings.push(
        "DATA_ENCRYPTION_KEY is not set — at-rest field encryption is INACTIVE. " +
          "Generate one with: openssl rand -base64 32"
      );
    }
    return null;
  }

  const trimmed = String(raw).trim();
  let buf;
  try {
    buf = /^[0-9a-f]{64}$/i.test(trimmed)
      ? Buffer.from(trimmed, "hex")
      : Buffer.from(trimmed, "base64");
  } catch {
    errors.push("DATA_ENCRYPTION_KEY must be base64- or hex-encoded.");
    return null;
  }

  if (buf.length !== 32) {
    errors.push(
      `DATA_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256 (got ${buf.length}). ` +
        "Generate one with: openssl rand -base64 32"
    );
    return null;
  }

  // All-zero or single-byte-repeated keys indicate a placeholder, not a secret.
  if (new Set(buf).size < 8) {
    errors.push("DATA_ENCRYPTION_KEY has insufficient entropy — use a random 32-byte value.");
    return null;
  }

  return buf;
}

const DATA_ENCRYPTION_KEY = parseEncryptionKey();

// ── Datastore ────────────────────────────────────────────────────────────────
const SUPABASE_URL = requireVar("SUPABASE_URL", { productionOnly: true });
const SUPABASE_SERVICE_ROLE_KEY = requireVar("SUPABASE_SERVICE_ROLE_KEY", {
  productionOnly: true,
});
const DATABASE_URL = process.env.DATABASE_URL || null;

if (IS_PRODUCTION && !DATABASE_URL) {
  warnings.push("DATABASE_URL is not set — features requiring direct Postgres access are disabled.");
}

/**
 * Certificate verification for direct Postgres connections.
 *
 * Defaults to `true` UNCONDITIONALLY, not to IS_PRODUCTION. Tying a security
 * default to NODE_ENV means a deploy where that variable is unset, misspelled,
 * or set to "prod" silently drops to an unverified TLS connection — and nothing
 * in the logs looks wrong. NODE_ENV is far too easy to get wrong on Render or
 * Vercel to hang certificate verification off it.
 *
 * This costs local development nothing: buildSslOptions() disables TLS outright
 * for localhost/127.0.0.1 connections, which an attacker cannot reach anyway.
 * A developer pointing at a remote database with a private CA supplies
 * DATABASE_CA_CERT, or opts out explicitly — and that opt-out logs a warning on
 * every pool creation.
 */
const DATABASE_SSL_REJECT_UNAUTHORIZED = boolVar("DATABASE_SSL_REJECT_UNAUTHORIZED", true);

// ── CORS ─────────────────────────────────────────────────────────────────────
const CORS_ALLOWED_ORIGINS = listVar("CORS_ALLOWED_ORIGINS", []);
if (IS_PRODUCTION && CORS_ALLOWED_ORIGINS.length === 0) {
  errors.push(
    "CORS_ALLOWED_ORIGINS must list every approved frontend origin in production " +
      '(e.g. "https://app.example.com,https://www.example.com").'
  );
}
for (const origin of CORS_ALLOWED_ORIGINS) {
  if (origin === "*") {
    errors.push("CORS_ALLOWED_ORIGINS must not contain a wildcard '*'.");
  } else if (IS_PRODUCTION && !origin.startsWith("https://")) {
    errors.push(`CORS origin "${origin}" must use https:// in production.`);
  }
}

// ── Auth / session tunables ──────────────────────────────────────────────────
const config = Object.freeze({
  NODE_ENV,
  IS_PRODUCTION,
  IS_TEST,
  PORT: intVar("PORT", 4000, { min: 1, max: 65535 }),

  JWT_SECRET,
  JWT_REFRESH_SECRET,
  JWT_ISSUER: process.env.JWT_ISSUER || "datahub-api",
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || "datahub-app",

  /** Access token lifetime in seconds. Short by design — 15 minutes. */
  ACCESS_TOKEN_TTL_SECONDS: intVar("ACCESS_TOKEN_TTL_SECONDS", 15 * 60, {
    min: 60,
    max: 60 * 60,
  }),
  /** Absolute refresh token lifetime in seconds — 7 days. */
  REFRESH_TOKEN_TTL_SECONDS: intVar("REFRESH_TOKEN_TTL_SECONDS", 7 * 24 * 60 * 60, {
    min: 5 * 60,
    max: 30 * 24 * 60 * 60,
  }),
  /** Idle timeout: a session dies after this long with no refresh — 30 minutes. */
  SESSION_IDLE_TIMEOUT_SECONDS: intVar("SESSION_IDLE_TIMEOUT_SECONDS", 30 * 60, {
    min: 60,
    max: 24 * 60 * 60,
  }),
  /** Absolute session cap regardless of activity — 12 hours. */
  SESSION_ABSOLUTE_TIMEOUT_SECONDS: intVar(
    "SESSION_ABSOLUTE_TIMEOUT_SECONDS",
    12 * 60 * 60,
    { min: 5 * 60, max: 30 * 24 * 60 * 60 }
  ),
  /** Enforce exactly one active session per user. */
  SINGLE_DEVICE_LOGIN: boolVar("SINGLE_DEVICE_LOGIN", true),

  BCRYPT_ROUNDS: intVar("BCRYPT_ROUNDS", 12, { min: 12, max: 15 }),

  // ── Account lockout ────────────────────────────────────────────────────────
  LOGIN_MAX_FAILED_ATTEMPTS: intVar("LOGIN_MAX_FAILED_ATTEMPTS", 5, { min: 3, max: 20 }),
  LOGIN_ATTEMPT_WINDOW_SECONDS: intVar("LOGIN_ATTEMPT_WINDOW_SECONDS", 15 * 60, {
    min: 60,
    max: 24 * 60 * 60,
  }),
  LOGIN_LOCKOUT_SECONDS: intVar("LOGIN_LOCKOUT_SECONDS", 15 * 60, {
    min: 60,
    max: 24 * 60 * 60,
  }),
  LOGIN_LOCKOUT_NOTIFY: boolVar("LOGIN_LOCKOUT_NOTIFY", true),

  // ── Rate limiting ──────────────────────────────────────────────────────────
  RATE_LIMIT_GLOBAL_MAX: intVar("RATE_LIMIT_GLOBAL_MAX", 600, { min: 10 }),
  RATE_LIMIT_GLOBAL_WINDOW_SECONDS: intVar("RATE_LIMIT_GLOBAL_WINDOW_SECONDS", 60, { min: 1 }),
  RATE_LIMIT_AUTH_MAX: intVar("RATE_LIMIT_AUTH_MAX", 10, { min: 1 }),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: intVar("RATE_LIMIT_AUTH_WINDOW_SECONDS", 15 * 60, { min: 1 }),
  RATE_LIMIT_BURST_MAX: intVar("RATE_LIMIT_BURST_MAX", 40, { min: 1 }),
  RATE_LIMIT_BURST_WINDOW_SECONDS: intVar("RATE_LIMIT_BURST_WINDOW_SECONDS", 5, { min: 1 }),
  RATE_LIMIT_BLOCK_SECONDS: intVar("RATE_LIMIT_BLOCK_SECONDS", 15 * 60, { min: 10 }),
  RATE_LIMIT_BLOCK_THRESHOLD: intVar("RATE_LIMIT_BLOCK_THRESHOLD", 5, { min: 1 }),

  // ── Transport ──────────────────────────────────────────────────────────────
  /** Render/Vercel terminate TLS upstream, so trust exactly one proxy hop. */
  TRUST_PROXY_HOPS: intVar("TRUST_PROXY_HOPS", 1, { min: 0, max: 10 }),
  FORCE_HTTPS: boolVar("FORCE_HTTPS", IS_PRODUCTION),
  HSTS_MAX_AGE_SECONDS: intVar("HSTS_MAX_AGE_SECONDS", 63072000, { min: 0 }),

  // ── Uploads ────────────────────────────────────────────────────────────────
  UPLOAD_MAX_BYTES: intVar("UPLOAD_MAX_BYTES", 25 * 1024 * 1024, {
    min: 1024,
    max: 500 * 1024 * 1024,
  }),

  // ── Datastore ──────────────────────────────────────────────────────────────
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  DATABASE_URL,
  DATABASE_SSL_REJECT_UNAUTHORIZED,

  CORS_ALLOWED_ORIGINS,
  DATA_ENCRYPTION_KEY,

  FRONTEND_URL: process.env.FRONTEND_URL || null,
  LOG_LEVEL: process.env.LOG_LEVEL || (IS_PRODUCTION ? "info" : "debug"),
});

/**
 * Validates the environment and terminates the process on any hard error.
 * Called explicitly from server.js so that test harnesses can import config
 * without triggering an exit.
 */
function assertEnvironment() {
  for (const warning of warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[env] WARNING: ${warning}`);
  }

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      "\n[env] FATAL: environment validation failed. Refusing to start.\n" +
        errors.map((message) => `  ✗ ${message}`).join("\n") +
        "\n\nSee backend/.env.example for the full list of required variables.\n"
    );
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[env] Validated for NODE_ENV=${NODE_ENV} ` +
      `(access TTL ${config.ACCESS_TOKEN_TTL_SECONDS}s, idle timeout ${config.SESSION_IDLE_TIMEOUT_SECONDS}s, ` +
      `single-device=${config.SINGLE_DEVICE_LOGIN}, https=${config.FORCE_HTTPS})`
  );
}

module.exports = { config, assertEnvironment, envErrors: errors, envWarnings: warnings };
