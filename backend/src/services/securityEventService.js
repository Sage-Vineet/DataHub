"use strict";

/**
 * Append-only security audit trail.
 *
 * WHY: OWASP A09:2021 (Security Logging and Monitoring Failures) exists because
 * most breaches are discovered by third parties months after the fact. Without
 * a durable record of authentication decisions you cannot answer "was this
 * account accessed?", which is a regulatory requirement for a financial system,
 * not merely good practice.
 *
 * Recording is deliberately best-effort and never throws: an audit write must
 * not be able to fail a login or, worse, become a denial-of-service lever. It
 * mirrors to the application log so nothing is lost if the DB write fails.
 */

const { supabase } = require("../db");
const logger = require("../security/logger");

const TABLE = "security_events";

const SEVERITY = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  CRITICAL: "critical",
});

/**
 * Whitelist of metadata keys allowed into the audit table.
 *
 * WHY a whitelist rather than a blocklist: callers evolve, and one careless
 * `metadata: req.body` would drop credentials into permanent storage. Anything
 * not named here is dropped.
 */
const ALLOWED_METADATA_KEYS = new Set([
  "reason", "sessionId", "familyId", "role", "subRole", "previousRole",
  "companyId", "resource", "action", "method", "path", "status",
  "attemptCount", "lockedUntil", "singleDevice", "revokedCount",
  "provider", "outcome", "limit", "windowSeconds", "retryAfter",
  "mimeType", "extension", "sizeBytes", "rejectedBy", "origin",
  "targetUserId", "changedFields",
]);

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  const output = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      output[key] = JSON.stringify(value).slice(0, 500);
    } else {
      output[key] = String(value).slice(0, 500);
    }
  }
  return output;
}

/**
 * Records a security event.
 *
 * @param {object} params
 * @param {string} params.eventType   stable machine-readable name
 * @param {string} [params.severity]  info | warning | critical
 * @param {string} [params.userId]
 * @param {string} [params.email]     stored for failed logins where no user exists
 * @param {string} [params.ipHash]    already-hashed IP (never the raw address)
 * @param {string} [params.userAgent]
 * @param {string} [params.requestId]
 * @param {object} [params.metadata]  filtered against ALLOWED_METADATA_KEYS
 */
async function record({
  eventType,
  severity = SEVERITY.INFO,
  userId = null,
  email = null,
  ipHash = null,
  userAgent = null,
  requestId = null,
  metadata = {},
} = {}) {
  const safeMetadata = sanitizeMetadata(metadata);

  // Always mirror to the application log — this is the copy that survives a
  // database outage and feeds log-based alerting.
  const logLevel =
    severity === SEVERITY.CRITICAL ? "error" : severity === SEVERITY.WARNING ? "warn" : "info";
  logger[logLevel](`security_event:${eventType}`, {
    userId,
    email,
    ipHash,
    requestId,
    ...safeMetadata,
  });

  if (!supabase) return;

  try {
    const { error } = await supabase.from(TABLE).insert({
      event_type: String(eventType).slice(0, 100),
      severity,
      user_id: userId,
      email: email ? String(email).toLowerCase().slice(0, 320) : null,
      ip_hash: ipHash,
      user_agent: userAgent ? String(userAgent).slice(0, 256) : null,
      request_id: requestId ? String(requestId).slice(0, 64) : null,
      metadata: safeMetadata,
    });
    if (error) {
      logger.warn("security_event_persist_failed", { eventType, code: error.code });
    }
  } catch (error) {
    logger.warn("security_event_persist_threw", { eventType, name: error.name });
  }
}

/** Convenience wrapper that pulls request context off an Express request. */
function fromRequest(req) {
  return {
    ipHash: logger.hashIp(req.ip),
    userAgent: req.headers?.["user-agent"] || null,
    requestId: req.id || null,
    userId: req.user?.id || null,
  };
}

/** Reads recent events for an admin-facing audit view. */
async function listRecent({ userId = null, severity = null, limit = 100 } = {}) {
  if (!supabase) return [];
  let query = supabase
    .from(TABLE)
    .select("id, event_type, severity, user_id, email, request_id, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.min(Number(limit) || 100, 500));

  if (userId) query = query.eq("user_id", userId);
  if (severity) query = query.eq("severity", severity);

  const { data, error } = await query;
  if (error) {
    logger.warn("security_event_list_failed", { code: error.code });
    return [];
  }
  return data || [];
}

module.exports = { SEVERITY, record, fromRequest, listRecent };
