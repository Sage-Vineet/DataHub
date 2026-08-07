"use strict";

/**
 * Layered rate limiting.
 *
 * WHY four layers rather than one global limiter:
 *   • Burst      — a very short window catches scripted floods that a 1-minute
 *                  window would average away.
 *   • Sustained  — the ordinary per-IP/per-user ceiling.
 *   • Endpoint   — auth and upload routes are far more valuable to an attacker
 *                  and far cheaper to protect with a tight limit.
 *   • Blocklist  — a client that repeatedly trips limits is temporarily refused
 *                  outright, so abuse costs the server almost nothing.
 *
 * Keying: authenticated traffic is keyed on user id, not IP. Otherwise a whole
 * office behind one NAT shares a budget, and an attacker with a pool of
 * addresses evades the limit entirely.
 *
 * DEPLOYMENT NOTE: this store is in-process. On Render with more than one
 * instance each instance holds its own counters, so effective limits multiply
 * by the instance count. Set REDIS_URL and swap in `rate-limit-redis` for a
 * shared store before scaling out — see SECURITY.md.
 */

const rateLimit = require("express-rate-limit");
const { config } = require("../config/env");
const logger = require("../security/logger");
const securityEvents = require("../services/securityEventService");

// ── Temporary blocklist ─────────────────────────────────────────────────────
const blocked = new Map(); // key -> { until, strikes }
const BLOCKLIST_MAX = 10000;

function blockKey(req) {
  return req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`;
}

function isBlocked(key) {
  const entry = blocked.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.until) {
    blocked.delete(key);
    return null;
  }
  return entry;
}

function addStrike(key) {
  const existing = blocked.get(key);
  const strikes = (existing?.strikes || 0) + 1;

  if (strikes < config.RATE_LIMIT_BLOCK_THRESHOLD) {
    blocked.set(key, { until: Date.now() + 60 * 1000, strikes, soft: true });
    return null;
  }

  // Exponential backoff, capped at 24h, so a persistent abuser gets
  // progressively more expensive to be.
  const multiplier = Math.min(2 ** (strikes - config.RATE_LIMIT_BLOCK_THRESHOLD), 96);
  const durationMs = Math.min(
    config.RATE_LIMIT_BLOCK_SECONDS * 1000 * multiplier,
    24 * 60 * 60 * 1000
  );
  const until = Date.now() + durationMs;

  if (blocked.size >= BLOCKLIST_MAX) {
    // Evict the entry expiring soonest rather than an arbitrary one.
    let oldestKey = null;
    let oldestUntil = Infinity;
    for (const [candidate, entry] of blocked) {
      if (entry.until < oldestUntil) {
        oldestUntil = entry.until;
        oldestKey = candidate;
      }
    }
    if (oldestKey) blocked.delete(oldestKey);
  }

  blocked.set(key, { until, strikes, soft: false });
  return { until, durationMs };
}

/** Periodically drop expired entries so the map cannot grow unbounded. */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of blocked) {
    if (entry.until <= now) blocked.delete(key);
  }
}, 60 * 1000);
sweeper.unref?.();

/**
 * Rejects clients currently under a temporary block. Mount this first so a
 * blocked client is refused before any handler work is done.
 */
function blocklistGuard(req, res, next) {
  const key = blockKey(req);
  const entry = isBlocked(key);
  if (!entry) return next();

  const retryAfter = Math.ceil((entry.until - Date.now()) / 1000);
  res.set("Retry-After", String(retryAfter));
  return res.status(429).json({
    error: "Too many requests. Access temporarily suspended.",
    code: "TEMPORARILY_BLOCKED",
    retryAfter,
  });
}

function onLimitReached(name) {
  return async (req, res, _next, options) => {
    const key = blockKey(req);
    const block = addStrike(key);

    await securityEvents.record({
      eventType: block ? "rate_limit_block_applied" : "rate_limit_exceeded",
      severity: block
        ? securityEvents.SEVERITY.WARNING
        : securityEvents.SEVERITY.INFO,
      ...securityEvents.fromRequest(req),
      metadata: {
        limit: options.limit,
        windowSeconds: Math.round(options.windowMs / 1000),
        path: req.path,
        method: req.method,
        reason: name,
        ...(block ? { retryAfter: Math.ceil(block.durationMs / 1000) } : {}),
      },
    });

    const retryAfter = block
      ? Math.ceil(block.durationMs / 1000)
      : Math.ceil(options.windowMs / 1000);

    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({
      error: "Too many requests. Please slow down.",
      code: block ? "TEMPORARILY_BLOCKED" : "RATE_LIMITED",
      retryAfter,
    });
  };
}

/**
 * Key generator. `express-rate-limit` v7+ requires IPv6-safe handling, which
 * its own ipKeyGenerator helper provides — a raw IPv6 address would otherwise
 * let an attacker with a /64 allocation get one budget per address.
 */
function makeKeyGenerator() {
  const { ipKeyGenerator } = rateLimit;
  return (req) => {
    if (req.user?.id) return `u:${req.user.id}`;
    return typeof ipKeyGenerator === "function" ? ipKeyGenerator(req.ip) : `ip:${req.ip}`;
  };
}

function build({ name, windowSeconds, max, skipSuccessful = false, byUser = true }) {
  return rateLimit({
    windowMs: windowSeconds * 1000,
    limit: max,
    standardHeaders: "draft-7", // RateLimit-* headers per IETF draft
    legacyHeaders: false,
    skipSuccessfulRequests: skipSuccessful,
    keyGenerator: byUser ? makeKeyGenerator() : undefined,
    handler: onLimitReached(name),
    // Health checks must never be throttled — Render uses them for liveness.
    skip: (req) => req.path === "/health" || req.path === "/healthz",
  });
}

// ── Layer 1: burst protection ───────────────────────────────────────────────
const burstLimiter = build({
  name: "burst",
  windowSeconds: config.RATE_LIMIT_BURST_WINDOW_SECONDS,
  max: config.RATE_LIMIT_BURST_MAX,
});

// ── Layer 2: sustained global limit ─────────────────────────────────────────
const globalLimiter = build({
  name: "global",
  windowSeconds: config.RATE_LIMIT_GLOBAL_WINDOW_SECONDS,
  max: config.RATE_LIMIT_GLOBAL_MAX,
});

// ── Layer 3: authentication endpoints ───────────────────────────────────────
// Always keyed by IP: a pre-auth request has no user, and keying on the
// submitted email would let an attacker rotate addresses to reset the counter.
const authLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_AUTH_WINDOW_SECONDS * 1000,
  limit: config.RATE_LIMIT_AUTH_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Successful logins do not consume budget, so a legitimate user who signs in
  // and out repeatedly is never locked out by this layer.
  skipSuccessfulRequests: true,
  handler: onLimitReached("auth"),
});

/** Stricter still: password reset and OTP send, which cost email deliverability. */
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: onLimitReached("sensitive"),
});

/** Uploads are expensive in bandwidth, storage and downstream parsing. */
const uploadLimiter = build({
  name: "upload",
  windowSeconds: 60,
  max: 20,
});

/** AI/report generation — expensive in third-party API spend. */
const expensiveLimiter = build({
  name: "expensive",
  windowSeconds: 60,
  max: 10,
});

/** Test/administrative hook to clear state. */
function resetBlocklist() {
  blocked.clear();
}

module.exports = {
  blocklistGuard,
  burstLimiter,
  globalLimiter,
  authLimiter,
  sensitiveLimiter,
  uploadLimiter,
  expensiveLimiter,
  resetBlocklist,
  _internals: { blocked, addStrike, isBlocked },
};
