"use strict";

/**
 * Redacting structured logger.
 *
 * WHY: Logs are routinely shipped to third-party aggregators, read by staff who
 * are not authorised to see customer data, and retained far longer than the
 * secrets inside them stay valid. A JWT or connection string in a log line is a
 * credential at rest with no access control. This logger scrubs known-sensitive
 * keys and pattern-matches secret-shaped strings anywhere in the payload before
 * anything reaches stdout.
 *
 * Prevents: credential leakage via log aggregation (OWASP A09:2021 Security
 * Logging and Monitoring Failures), PII over-collection.
 */

const { config } = require("../config/env");

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const ACTIVE_LEVEL = LEVELS[config.LOG_LEVEL] ?? LEVELS.info;

/** Keys whose values are replaced wholesale, matched case-insensitively. */
const REDACTED_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|jwt|authorization|auth|cookie|session|api[-_]?key|client[-_]?secret|refresh|credential|connection[-_]?string|private[-_]?key|salt|hash|otp|ssn|tax[-_]?id|card|cvv|iban|account[-_]?number)/i;

/** Keys holding personal data that is reduced rather than removed. */
const PII_KEY_PATTERN = /^(email|phone|mobile|address|full[-_]?name|first[-_]?name|last[-_]?name|dob|date[-_]?of[-_]?birth)$/i;

/** Secret-shaped values detected regardless of the key they sit under. */
const VALUE_PATTERNS = [
  // JWTs (three base64url segments)
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  // Postgres / MySQL / Mongo connection strings
  /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/gi,
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi,
  // Basic auth headers
  /\bBasic\s+[A-Za-z0-9+/]{10,}=*/gi,
  // Common vendor key prefixes (Stripe, GitHub, Slack, Google, OpenAI, Anthropic)
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  // bcrypt hashes
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g,
  // PEM private keys
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
];

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 25;
const MAX_STRING_LENGTH = 2000;

/** Masks an email as `a***@example.com` so it stays correlatable but not readable. */
function maskEmail(value) {
  const text = String(value);
  const at = text.indexOf("@");
  if (at <= 0) return maskGeneric(text);
  return `${text[0]}***${text.slice(at)}`;
}

function maskGeneric(value) {
  const text = String(value);
  if (text.length <= 2) return "**";
  return `${text[0]}***${text[text.length - 1]}`;
}

/**
 * Email addresses appearing inside free text — an error message, a validation
 * detail, a third-party API response. Masked rather than removed so the entry
 * stays diagnosable, matching how the `email` key itself is handled.
 */
const EMAIL_IN_TEXT = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

function scrubString(value) {
  let output = String(value);
  if (output.length > MAX_STRING_LENGTH) {
    output = `${output.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
  }
  for (const pattern of VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  // Applied after the secret patterns so a JWT or DSN is already gone and
  // cannot be partially rewritten by this.
  output = output.replace(EMAIL_IN_TEXT, (_match, first, domain) => `${first}***@${domain}`);
  return output;
}

/**
 * Recursively redacts an arbitrary value. Cycles are broken with a marker so a
 * self-referencing object (e.g. an Express req) can never hang the logger.
 */
function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return "[Symbol]";

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      // Stacks are kept out of production output entirely — see log().
      ...(config.IS_PRODUCTION ? {} : { stack: scrubString(value.stack || "") }),
    };
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length}B]`;

  if (depth >= MAX_DEPTH) return "[Object depth limit]";

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`…${value.length - MAX_ARRAY_ITEMS} more`);
    }
    return items;
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (REDACTED_KEY_PATTERN.test(key)) {
        output[key] = REDACTED;
      } else if (PII_KEY_PATTERN.test(key)) {
        // Preserve null/undefined rather than masking them — `null` became
        // "n***l", which reads like a redacted value and hides the fact that
        // the field was simply absent.
        output[key] =
          entry === null || entry === undefined
            ? entry
            : /email/i.test(key)
              ? maskEmail(entry)
              : maskGeneric(entry);
      } else {
        output[key] = redact(entry, depth + 1, seen);
      }
    }
    return output;
  }

  return "[Unknown]";
}

function log(level, message, context) {
  if (LEVELS[level] > ACTIVE_LEVEL) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: scrubString(message),
  };

  if (context !== undefined && context !== null) {
    entry.ctx = redact(context);
  }

  const line = config.IS_PRODUCTION ? JSON.stringify(entry) : formatPretty(entry);
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

function formatPretty(entry) {
  const ctx = entry.ctx ? ` ${JSON.stringify(entry.ctx)}` : "";
  return `[${entry.ts}] ${entry.level.toUpperCase()} ${entry.msg}${ctx}`;
}

/**
 * Express request logger. Deliberately records only operational metadata:
 * method, route, status, duration, and correlation ids. Never the query string
 * (which may carry tokens on legacy clients), body, or headers.
 */
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    log(level, "http_request", {
      method: req.method,
      // req.route?.path keeps cardinality low and avoids logging path ids.
      path: req.baseUrl ? `${req.baseUrl}${req.route?.path || ""}` : req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      requestId: req.id || null,
      userId: req.user?.id || null,
      ip: hashIp(req.ip),
    });
  });
  next();
}

/**
 * IPs are personal data under GDPR. We log a stable truncated hash so abuse can
 * still be correlated across requests without retaining the address itself.
 */
const crypto = require("crypto");
const IP_HASH_SALT = crypto.randomBytes(16);
function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash("sha256").update(IP_HASH_SALT).update(String(ip)).digest("hex").slice(0, 12);
}

module.exports = {
  error: (message, context) => log("error", message, context),
  warn: (message, context) => log("warn", message, context),
  info: (message, context) => log("info", message, context),
  debug: (message, context) => log("debug", message, context),
  redact,
  requestLogger,
  hashIp,
};
