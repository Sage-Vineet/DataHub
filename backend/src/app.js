const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { errorHandler } = require("./middleware/error");
const { timingMiddleware } = require("./middleware/timing");

// Routes
const { quickBooksAuth } = require("./middleware/quickbooksAuth");
const keyReportRoutes = require("./routes/keyReports");
const tokenRoutes = require("./routes/quickbooks/token");
const profitAndLossRoutes = require("./routes/quickbooks/profit_and_loss/profitAndLoss");
const geminipdf = require("./routes/quickbooks/tax_reconciliation/geminiPdf");
const bankVsBooksRoutes = require("./routes/quickbooks/reconciliation/bankVsBooks");

const app = express();

function normalizeOrigin(origin) {
  try {
    return new URL(origin).origin;
  } catch (_error) {
    return String(origin || "").replace(/\/$/, "");
  }
}

function parseOriginList(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(normalizeOrigin);
}

function isAllowedVercelPreview(origin) {
  try {
    const { hostname, protocol } = new URL(origin);
    return (
      protocol === "https:" &&
      (
        hostname.endsWith(".vercel.app") ||
        hostname === "centurium.com" ||
        hostname === "www.centurium.com"
      )
    );
  } catch (_error) {
    return false;
  }
}

const allowedOrigins = Array.from(
  new Set([
    process.env.FRONTEND_URL,
    process.env.APP_URL,
    process.env.CORS_ORIGIN,
    ...parseOriginList(process.env.CORS_ORIGIN),
    "https://centurium.com",
    "https://www.centurium.com",
    "https://data-hub-fawn.vercel.app",
    "https://datahub-sl3y.onrender.com",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5175",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ])
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalizedOrigin = normalizeOrigin(origin);
      if (
        allowedOrigins.includes(normalizedOrigin) ||
        isAllowedVercelPreview(normalizedOrigin)
      ) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));
app.use(timingMiddleware);

app.get("/health", (req, res) => res.json({ ok: true }));

// Standard Routes
app.use("/", tokenRoutes);
app.use("/", keyReportRoutes);

// QuickBooks & Financial Routes (with consolidated auth)
const financialRoutes = [
  profitAndLossRoutes,
  geminipdf,
  bankVsBooksRoutes,
];

financialRoutes.forEach(route => {
  app.use("/", quickBooksAuth(route), route);
});

// Non-QuickBooks Routes
//
// activity, companies, folders, folder-access, uploads, users, groups, requests,
// reminders, messages and message-groups are NOT mounted here:
// their modules in apps/api serve every route they defined, so the gateway never
// proxies those paths. See tools/parity/route-surface.json for what is still
// legacy-only.

app.use(errorHandler);

module.exports = app;
