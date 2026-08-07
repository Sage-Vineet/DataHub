"use strict";

/**
 * HTTP security headers, HTTPS enforcement and request correlation.
 *
 * These headers are the browser-side half of the security model: they tell the
 * user agent to refuse behaviour the server cannot prevent on its own.
 */

const crypto = require("crypto");
const helmet = require("helmet");
const { config } = require("../config/env");
const securityEvents = require("../services/securityEventService");

/**
 * Assigns a request id, echoed in the response and attached to every log line.
 *
 * WHY: lets an operator trace a user-reported error to its log entry without
 * the error response having to leak a stack trace.
 */
function requestId(req, res, next) {
  const incoming = req.headers["x-request-id"];
  // Only accept a client-supplied id if it is safely formatted — otherwise it
  // is an injection vector into log files (CRLF) and downstream dashboards.
  req.id =
    typeof incoming === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(incoming)
      ? incoming
      : crypto.randomUUID();
  res.set("X-Request-Id", req.id);
  next();
}

/**
 * Redirects HTTP to HTTPS and refuses insecure non-idempotent requests.
 *
 * WHY the method split: a 301 on a GET is safe and preserves usability. A POST
 * carrying credentials over cleartext has *already* leaked them by the time we
 * see it — redirecting would also drop the body, so we reject outright and make
 * the failure visible rather than silently losing data.
 *
 * Render and Vercel terminate TLS at the edge, so the original scheme arrives
 * in X-Forwarded-Proto. That header is only trustworthy because `trust proxy`
 * is set to a fixed hop count in app.js — with `trust proxy: true` any client
 * could spoof it.
 */
function enforceHttps(req, res, next) {
  if (!config.FORCE_HTTPS) return next();

  const forwardedProto = req.get("x-forwarded-proto");
  const proto = (forwardedProto || req.protocol || "").split(",")[0].trim();

  if (proto === "https" || req.secure) return next();

  // Health checks arrive over HTTP from the platform's internal network.
  if (req.path === "/health" || req.path === "/healthz") return next();

  const host = req.get("host");
  if (!host || !/^[A-Za-z0-9.\-:]+$/.test(host)) {
    // A malformed Host header must not be reflected into a Location response —
    // that is an open-redirect / host-header-injection primitive.
    return res.status(400).json({ error: "Bad request", code: "BAD_HOST" });
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }

  return res.status(403).json({
    error: "HTTPS is required for this request.",
    code: "HTTPS_REQUIRED",
  });
}

/**
 * Helmet configuration.
 *
 * This service is a JSON API: it serves no HTML of its own, so the CSP is
 * locked to `'none'` almost everywhere. That matters because API endpoints that
 * echo user input can otherwise be coerced into rendering as HTML in a browser
 * (reflected XSS via content sniffing) — `default-src 'none'` plus
 * `X-Content-Type-Options: nosniff` removes that class of bug entirely.
 *
 * The frontend is served by Vercel and needs its own, looser CSP — that lives
 * in vercel.json, not here.
 */
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      "default-src": ["'none'"],
      "script-src": ["'none'"],
      "style-src": ["'none'"],
      "img-src": ["'none'"],
      "font-src": ["'none'"],
      "connect-src": ["'none'"],
      "object-src": ["'none'"],
      "media-src": ["'none'"],
      "frame-src": ["'none'"],
      "frame-ancestors": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
      // Instructs the browser to upgrade any subresource request to HTTPS.
      ...(config.FORCE_HTTPS ? { "upgrade-insecure-requests": [] } : {}),
    },
  },

  // Deny framing entirely — this API has no legitimate embedded use, so
  // clickjacking and drag-and-drop attacks are impossible.
  frameguard: { action: "deny" },

  // Stops MIME sniffing, which is what turns a JSON response containing
  // attacker text into an executed HTML document in older browsers.
  noSniff: true,

  // Send only the origin cross-site, and nothing at all when downgrading to
  // HTTP — prevents URLs (which may carry ids) leaking to third parties.
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },

  // HSTS: after the first successful HTTPS response the browser refuses to
  // speak HTTP to this host at all, closing the SSL-strip window.
  hsts: config.FORCE_HTTPS
    ? {
        maxAge: config.HSTS_MAX_AGE_SECONDS,
        includeSubDomains: true,
        preload: true,
      }
    : false,

  // Blocks other origins from embedding this API's responses as a resource —
  // the mitigation for Spectre-style cross-origin leaks (XS-Leaks).
  crossOriginResourcePolicy: { policy: "same-site" },

  // COEP is deliberately off: it breaks legitimate cross-origin fetches from
  // the Vercel-hosted frontend and buys nothing for a JSON API.
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin" },

  // Removes X-Powered-By. Version fingerprints let an attacker match a target
  // to a public CVE without probing.
  hidePoweredBy: true,

  // Legacy IE protection; also stops IE rendering downloads inline.
  ieNoOpen: true,

  // X-XSS-Protection: 0. The legacy auditor is itself exploitable, and modern
  // browsers ignore it; CSP is the real control.
  xssFilter: true,

  dnsPrefetchControl: { allow: false },
  originAgentCluster: true,
});

/** Headers helmet does not cover. */
function supplementalHeaders(req, res, next) {
  // Disables browser features this API never needs, in case a response is ever
  // rendered as a document.
  res.set(
    "Permissions-Policy",
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), " +
      "encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), " +
      "magnetometer=(), microphone=(), midi=(), payment=(), " +
      "picture-in-picture=(), publickey-credentials-get=(), " +
      "screen-wake-lock=(), sync-xhr=(), usb=(), xr-spatial-tracking=()"
  );

  // Authenticated API responses must never be cached by a shared proxy — a
  // cached tenant response served to another tenant is a data breach.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  // Belt and braces: Express is told not to advertise itself in app.js, but a
  // library could re-add this.
  res.removeHeader("X-Powered-By");
  res.removeHeader("Server");

  next();
}

/**
 * Rejects requests whose Host header is not one we serve.
 *
 * WHY: host-header injection poisons absolute URLs generated by the app
 * (password-reset links, redirects) and can poison shared caches. Validating
 * against an allowlist stops it at the door.
 */
function hostAllowlist(allowedHosts) {
  const allowed = new Set(
    (allowedHosts || [])
      .map((entry) => {
        try {
          return new URL(entry).host.toLowerCase();
        } catch {
          return String(entry || "").toLowerCase();
        }
      })
      .filter(Boolean)
  );

  return async (req, res, next) => {
    if (allowed.size === 0) return next();
    const host = String(req.get("host") || "").toLowerCase();
    if (allowed.has(host)) return next();
    // Platform health probes hit the internal hostname.
    if (req.path === "/health" || req.path === "/healthz") return next();

    await securityEvents.record({
      eventType: "host_header_rejected",
      severity: securityEvents.SEVERITY.WARNING,
      ...securityEvents.fromRequest(req),
      metadata: { origin: host, path: req.path },
    });
    return res.status(400).json({ error: "Bad request", code: "BAD_HOST" });
  };
}

module.exports = {
  requestId,
  enforceHttps,
  helmetMiddleware,
  supplementalHeaders,
  hostAllowlist,
};
