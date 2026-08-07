"use strict";

/**
 * Central error handling.
 *
 * WHY the response is generic: a stack trace names your framework versions,
 * absolute filesystem paths, and internal module structure. A database error
 * string frequently contains table and column names, and sometimes the offending
 * value. Both are free reconnaissance. The full detail is logged server-side
 * against a request id; the client gets that id and nothing else.
 *
 * WHY errors are classified rather than blanket-500'd: a client genuinely needs
 * to distinguish "your input was wrong" from "we broke". Only errors explicitly
 * marked safe (`err.expose === true`, or a known operational class) have their
 * message forwarded.
 */

const logger = require("../security/logger");
const securityEvents = require("../services/securityEventService");
const { config } = require("../config/env");

/** Application error whose message is safe to show a caller. */
class AppError extends Error {
  constructor(message, { status = 400, code = "BAD_REQUEST", details = null } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

/** Maps well-known error shapes onto a safe client response. */
function classify(err) {
  // Explicitly-safe application errors.
  if (err instanceof AppError || err?.expose === true) {
    return {
      status: err.status || 400,
      code: err.code || "BAD_REQUEST",
      message: err.message,
      details: err.details || undefined,
    };
  }

  // JSON body parse failures from express.json().
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return { status: 400, code: "MALFORMED_JSON", message: "Malformed request body." };
  }
  if (err?.type === "entity.too.large") {
    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." };
  }

  // CORS rejections raised by the origin callback in app.js.
  if (err?.code === "CORS_NOT_ALLOWED") {
    return { status: 403, code: "CORS_NOT_ALLOWED", message: "Origin not allowed." };
  }

  // Multer upload failures.
  if (err?.name === "MulterError") {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "File exceeds the maximum allowed size."
        : "File upload rejected.";
    return { status: 400, code: "UPLOAD_REJECTED", message };
  }

  // Token and session errors carry their own status.
  if (err?.name === "TokenError" || err?.name === "SessionError") {
    return {
      status: err.status || 401,
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    };
  }

  // Postgres error codes. The message is NOT forwarded — it routinely embeds
  // constraint names, column names and offending values.
  if (typeof err?.code === "string" && /^[0-9A-Z]{5}$/.test(err.code)) {
    switch (err.code) {
      case "23505":
        return { status: 409, code: "CONFLICT", message: "That record already exists." };
      case "23503":
        return { status: 409, code: "CONFLICT", message: "Related record not found." };
      case "23514":
      case "22P02":
        return { status: 400, code: "BAD_REQUEST", message: "Invalid input." };
      case "42501":
        return { status: 403, code: "FORBIDDEN", message: "Access denied" };
      default:
        return { status: 500, code: "INTERNAL_ERROR", message: "Something went wrong." };
    }
  }

  // Anything unrecognised is a server fault and is never described.
  return { status: 500, code: "INTERNAL_ERROR", message: "Something went wrong." };
}

// eslint-disable-next-line no-unused-vars -- Express identifies the handler by arity
function errorHandler(err, req, res, next) {
  const classified = classify(err);

  // Full detail server-side only. The logger redacts secret-shaped values.
  const logContext = {
    requestId: req.id || null,
    method: req.method,
    path: req.path,
    status: classified.status,
    userId: req.user?.id || null,
    errorName: err?.name,
    errorCode: err?.code,
    // The message may contain user input; the logger scrubs token/DSN patterns.
    errorMessage: err?.message,
    ...(config.IS_PRODUCTION ? {} : { stack: err?.stack }),
  };

  if (classified.status >= 500) {
    logger.error("unhandled_error", logContext);
  } else {
    logger.warn("request_error", logContext);
  }

  // 5xx on an authenticated request is worth an audit entry — a burst of them
  // often precedes or accompanies an exploitation attempt.
  if (classified.status >= 500) {
    securityEvents
      .record({
        eventType: "server_error",
        severity: securityEvents.SEVERITY.WARNING,
        ...securityEvents.fromRequest(req),
        metadata: { path: req.path, method: req.method, status: classified.status },
      })
      .catch(() => {});
  }

  if (res.headersSent) return next(err);

  const body = {
    error: classified.message,
    code: classified.code,
    requestId: req.id || undefined,
  };
  if (classified.details) body.details = classified.details;

  return res.status(classified.status).json(body);
}

/** Terminal 404 handler — mounted after all routes, before errorHandler. */
function notFoundHandler(req, res) {
  return res.status(404).json({
    error: "Not found",
    code: "NOT_FOUND",
    requestId: req.id || undefined,
  });
}

/**
 * Process-level guards.
 *
 * An unhandled rejection leaves the process in an unknown state; continuing to
 * serve authenticated traffic from a corrupted process is worse than restarting.
 * Render/Vercel will bring it straight back up.
 */
function installProcessGuards() {
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", {
      name: reason?.name,
      errorMessage: reason?.message,
    });
  });

  process.on("uncaughtException", (error) => {
    logger.error("uncaught_exception", {
      name: error?.name,
      errorMessage: error?.message,
      stack: config.IS_PRODUCTION ? undefined : error?.stack,
    });
    // Flush the log, then exit so the platform restarts a clean process.
    setTimeout(() => process.exit(1), 100).unref();
  });
}

module.exports = { errorHandler, notFoundHandler, AppError, installProcessGuards };
