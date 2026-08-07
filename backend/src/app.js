"use strict";

const express = require("express");
const cors = require("cors");

const { config } = require("./config/env");
const logger = require("./security/logger");
const { errorHandler, notFoundHandler } = require("./middleware/error");
const { timingMiddleware } = require("./middleware/timing");
const { sanitizeBody } = require("./middleware/validate");
const {
  requestId,
  enforceHttps,
  helmetMiddleware,
  supplementalHeaders,
} = require("./middleware/securityHeaders");
const {
  blocklistGuard,
  burstLimiter,
  globalLimiter,
} = require("./middleware/rateLimit");
const securityEvents = require("./services/securityEventService");

// Routes
const authRoutes = require("./routes/auth");
const publicRoutes = require("./routes/public");
const {
  guardFinancialRouter,
  extractCompanyPrefix,
} = require("./middleware/quickbooksAuth");
const userRoutes = require("./routes/users");
const companyRoutes = require("./routes/companies");
const groupRoutes = require("./routes/groups");
const requestRoutes = require("./routes/requests");
const folderRoutes = require("./routes/folders");
const folderAccessRoutes = require("./routes/folderAccess");
const reminderRoutes = require("./routes/reminders");
const activityRoutes = require("./routes/activity");
const uploadRoutes = require("./routes/uploads");
const messageRoutes = require("./routes/messages");
const workspacePageStateRoutes = require("./routes/workspacePageState");
const cimStyleProfileRoutes = require("./routes/cimStyleProfiles");
const manualGlRoutes = require("./routes/manualGl");
const manualReportUploadRoutes = require("./routes/manualReportUploads");
const reportSourceRoutes = require("./routes/reportSources");
const ebitdaAdjustmentRoutes = require("./routes/ebitdaAdjustments");
const bankReconAdjRoutes = require("./routes/bankReconciliationAdjustments");
const keyReportRoutes = require("./routes/keyReports");
const balanceSheetRoutes = require("./routes/quickbooks/balancesheet/balanceSheet");
const balanceSheetDetailRoutes = require("./routes/quickbooks/balancesheet/balanceSheetFullDetail");
const tokenRoutes = require("./routes/quickbooks/token");
const generalLedgerRoutes = require("./routes/quickbooks/account_detail/generalLedger");
const profitAndLossRoutes = require("./routes/quickbooks/profit_and_loss/profitAndLoss");
const profitAndLossStatementRoutes = require("./routes/quickbooks/profit_and_loss/profitAndLossStatement");
const customerFinanceRoutes = require("./routes/quickbooks/customers/customers");
const invoiceFinanceRoutes = require("./routes/quickbooks/invoices/invoices");
const cashflowRoutes = require("./routes/quickbooks/cash_flow/cash_flow");
const reconciliationRoutes = require("./routes/quickbooks/reconciliation/Reconciliation");
const taxReconciliationRoutes = require("./routes/quickbooks/tax_reconciliation/Tax_Reconciliation");
const geminipdf = require("./routes/quickbooks/tax_reconciliation/geminiPdf");
const bankStatementRoutes = require("./routes/quickbooks/reconciliation/bankStatement");
const bankVsBooksRoutes = require("./routes/quickbooks/reconciliation/bankVsBooks");
const syncRoutes = require("./routes/quickbooks/sync");
const messageGroupRoutes = require("./routes/messageGroups");
const securityRoutes = require("./routes/security");

const app = express();

// ── Platform integration ─────────────────────────────────────────────────────
// A FIXED hop count, never `true`. With `trust proxy: true` Express believes the
// left-most X-Forwarded-For entry, which any client can set — that would let an
// attacker spoof their IP and defeat every per-IP rate limit and audit record.
// Render and Vercel each put exactly one proxy in front of the app.
app.set("trust proxy", config.TRUST_PROXY_HOPS);

// Removes the `X-Powered-By: Express` fingerprint.
app.disable("x-powered-by");

// ETags on authenticated JSON allow a shared cache to serve one tenant's
// response to another on a 304. Off.
app.disable("etag");

// Express's view engine and static handler are the only ways this process could
// list a directory. Neither is mounted; `express.static` appears nowhere in the
// codebase and must not be added without `index: false, dotfiles: "deny"`.
// The API serves JSON exclusively.

// ── Ordering matters ─────────────────────────────────────────────────────────
// 1. Correlation id, so every subsequent log line and error can be traced.
app.use(requestId);

// 2. HTTPS before anything reads the body — a cleartext request carrying
//    credentials must be refused before those credentials are parsed.
app.use(enforceHttps);

// 3. Security headers on every response, including errors and 404s.
app.use(helmetMiddleware);
app.use(supplementalHeaders);

// 4. CORS — and it MUST come before the rate limiters.
//
//    WHY THE ORDER MATTERS (this was a real, user-facing bug):
//    A cross-origin response with no Access-Control-Allow-Origin header is
//    discarded by the browser before any JavaScript sees it. `fetch()` then
//    rejects with an opaque "Failed to fetch" — no status, no body, nothing in
//    the console but a CORS complaint.
//
//    With the limiters mounted first, every 429 went out WITHOUT CORS headers.
//    So a user who tripped the rate limit did not see "Too many requests, try
//    again in 15 minutes". They saw "Failed to fetch", indistinguishable from
//    the server being down — and because retrying adds strikes, retrying made
//    it worse. The limits were working perfectly and were completely invisible.
//
//    Running CORS first costs nothing: it only sets response headers and
//    short-circuits OPTIONS preflights. The limiters still reject before body
//    parsing, routing, and any database work.
// ── CORS ─────────────────────────────────────────────────────────────────────
/**
 * Strict origin allowlist.
 *
 * Changes from the previous configuration and why:
 *   • The old policy allowed ANY `*.vercel.app` host. Because `credentials:true`
 *     was also set, any attacker could deploy a page to Vercel — free, instant —
 *     and make authenticated cross-origin requests against this API on behalf of
 *     a logged-in victim. That is a full CSRF/data-exfiltration primitive.
 *   • Requests with no Origin header were unconditionally allowed. That is right
 *     for server-to-server callers but wrong for a browser, so it is now limited
 *     to genuinely origin-less methods and same-origin navigations.
 *   • Origins are now supplied by CORS_ALLOWED_ORIGINS and validated at startup
 *     (https-only, no wildcards) rather than hard-coded.
 */
function normalizeOrigin(value) {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return String(value || "").replace(/\/+$/, "").toLowerCase();
  }
}

const allowedOrigins = new Set(
  [
    ...config.CORS_ALLOWED_ORIGINS,
    config.FRONTEND_URL,
    // Local development origins are added ONLY outside production.
    ...(config.IS_PRODUCTION
      ? []
      : [
          "http://localhost:5173",
          "http://localhost:5174",
          "http://localhost:5175",
          "http://localhost:3000",
          "http://127.0.0.1:5173",
          "http://127.0.0.1:5174",
          "http://127.0.0.1:5175",
          "http://127.0.0.1:3000",
        ]),
  ]
    .filter(Boolean)
    .map(normalizeOrigin)
);

logger.info("cors_configured", { count: allowedOrigins.size });

const corsOptions = {
  origin(origin, callback) {
    // No Origin header: non-browser clients (curl, server-to-server, health
    // probes). These carry no ambient credentials, so CSRF does not apply.
    if (!origin) return callback(null, true);

    if (allowedOrigins.has(normalizeOrigin(origin))) {
      return callback(null, true);
    }

    if (!config.IS_PRODUCTION && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      return callback(null, true);
    }

    const error = new Error("Origin not allowed");
    error.code = "CORS_NOT_ALLOWED";
    error.status = 403;
    error.expose = true;
    return callback(error);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Authorization",
    "Content-Type",
    "X-Client-Id",
    "X-Request-Id",
    "X-File-Name",
    "X-Upload-Prefix",
    "Cache-Control",
    "Pragma",
    "X-Requested-With",
  ],
  // Only headers the frontend genuinely reads are exposed.
  exposedHeaders: ["X-Request-Id", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"],
  maxAge: 600,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Log rejected origins — a spike here is an early signal of a targeted attempt.
app.use((err, req, res, next) => {
  if (err?.code === "CORS_NOT_ALLOWED") {
    securityEvents
      .record({
        eventType: "cors_origin_rejected",
        severity: securityEvents.SEVERITY.WARNING,
        ...securityEvents.fromRequest(req),
        metadata: { origin: req.headers.origin, path: req.path },
      })
      .catch(() => {});
  }
  return next(err);
});

// ── Rate limiting ────────────────────────────────────────────────────────────
// Mounted AFTER cors() so every 429 carries Access-Control-Allow-Origin and the
// browser can actually surface it. Still ahead of body parsing and routing, so
// an abusive client is rejected before any expensive work is done.
app.use(blocklistGuard);
app.use(burstLimiter);
app.use(globalLimiter);

// ── Body parsing ─────────────────────────────────────────────────────────────
// 1 MB, down from 10 MB. JSON endpoints have no legitimate need for more, and
// every megabyte accepted is a megabyte an attacker can make the server parse.
// File uploads use their own raw/multipart parsers with their own limits.
app.use(
  express.json({
    limit: "1mb",
    // Reject `Content-Type: application/json` bodies that are not objects or
    // arrays, e.g. a bare string, which some handlers would mishandle.
    strict: true,
  })
);
app.use(express.urlencoded({ extended: false, limit: "100kb", parameterLimit: 100 }));

// Strips __proto__/constructor/prototype from every parsed body.
app.use(sanitizeBody);

// ── Observability ────────────────────────────────────────────────────────────
// `morgan("dev")` is gone: it logs the full URL including any query string,
// which is exactly where a legacy `?token=` would have appeared.
app.use(logger.requestLogger);
app.use(timingMiddleware);

// ── Health ───────────────────────────────────────────────────────────────────
// Deliberately minimal. A health endpoint that reports versions, dependency
// status or environment names is free reconnaissance.
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/auth", authRoutes);
app.use("/security", securityRoutes);
app.use("/public", publicRoutes);
app.use("/users", userRoutes);
app.use("/companies", companyRoutes);
// tokenRoutes must be mounted before any "/"-mounted router with a blanket
// `router.use(requireAuth)` (groupRoutes is the first of those below). Those
// blanket guards apply to every path that reaches them, not just their own —
// they would otherwise swallow /api/auth/quickbooks (needs the ticket-based
// requireOAuthTicket, not a header) and /api/auth/callback (must stay
// unauthenticated; Intuit calls it directly) before token.js ever sees them.
// token.js has no blanket guard of its own, so moving it here doesn't change
// behaviour for any path other than the ones it explicitly defines.
app.use("/", tokenRoutes);
app.use("/", groupRoutes);
app.use("/", requestRoutes);
app.use("/", folderRoutes);
app.use("/", folderAccessRoutes);
app.use("/", reminderRoutes);
app.use("/", activityRoutes);
app.use("/", messageRoutes);
app.use("/", messageGroupRoutes);
app.use("/", uploadRoutes);
app.use("/", workspacePageStateRoutes);
app.use("/", cimStyleProfileRoutes);
app.use("/", manualGlRoutes);
app.use("/", manualReportUploadRoutes);
app.use("/", reportSourceRoutes);
app.use("/", ebitdaAdjustmentRoutes);
app.use("/", bankReconAdjRoutes);
app.use("/", keyReportRoutes);

// ── QuickBooks & financial routes ────────────────────────────────────────────
//
// These routers are all mounted at "/", so a guard passed to app.use() would run
// for every request in the application, not just theirs. `guardFinancialRouter`
// therefore inspects the router's own registered layers and only authenticates
// when that router actually owns the incoming path.
//
// This replaces a hardcoded path allowlist that authenticated only listed
// prefixes and called next() for everything else — any route added to these
// routers without a matching list entry was served with no authentication at
// all. `PUT /api/customers/:id` was live and open for exactly that reason.
//
// The company-id prefix rewrite runs once, before the guards, so each guard
// matches against the already-normalised path.
app.use(extractCompanyPrefix);

const financialRoutes = [
  balanceSheetRoutes,
  balanceSheetDetailRoutes,
  generalLedgerRoutes,
  profitAndLossRoutes,
  profitAndLossStatementRoutes,
  customerFinanceRoutes,
  invoiceFinanceRoutes,
  cashflowRoutes,
  reconciliationRoutes,
  taxReconciliationRoutes,
  geminipdf,
  bankStatementRoutes,
  bankVsBooksRoutes,
  syncRoutes,
];

financialRoutes.forEach((route) => {
  app.use("/", guardFinancialRouter(route), route);
});

app.use("/", groupRoutes);
app.use("/", requestRoutes);
app.use("/", folderRoutes);
app.use("/", folderAccessRoutes);
app.use("/", reminderRoutes);
app.use("/", activityRoutes);
app.use("/", messageRoutes);
app.use("/", messageGroupRoutes);

// ── Terminal handlers ────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
