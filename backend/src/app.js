const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { errorHandler } = require("./middleware/error");

const authRoutes = require("./routes/auth");
const { requireAuth } = require("./middleware/auth");
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
const db = require("./db");
const { getQBConfig, loadQBConfig, disconnectConfig } = require("./qbconfig");
const { logQuickBooksDebug } = require("./quickbooksLogger");
const tokenManager = require("./tokenManager");

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
        hostname === "centuriuum.com" ||
        hostname === "www.centuriuum.com"
      )
    );
  } catch (_error) {
    return false;
  }
}

const allowedOrigins = Array.from(
  new Set(
    [
      process.env.FRONTEND_URL,
      process.env.APP_URL,
      process.env.CORS_ORIGIN,
      ...parseOriginList(process.env.CORS_ORIGIN),
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
    ]
    //   .filter(Boolean)
    //   .map((origin) => origin.replace(/\/$/, "")),
    //   "https://data-hub-git-dataroom-vineet-s-projects-dcfecac9.vercel.app",
    //   "https://centuriuum.com"
    // ]
    //   .filter(Boolean)
    //   .map(normalizeOrigin),
  ),
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      // const normalizedOrigin = origin.replace(/\/$/, "");
      // if (allowedOrigins.includes(normalizedOrigin)) {
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

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/users", userRoutes);
app.use("/companies", companyRoutes);
app.use("/", tokenRoutes);
app.use("/", uploadRoutes);
app.use("/", geminipdf);
app.use("/", workspacePageStateRoutes);

function normalizeCompanyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function checkQBAuth(req, res, next) {
  // 1. Try existing req.clientId (from quickBooksAuth path extraction) or explicit header
  let clientId = req.clientId || req.headers["x-client-id"];

  // 2. Fallback: Try query parameter
  if (!clientId && req.query.clientId) {
    clientId = req.query.clientId;
  }

  // 3. Fallback: Try authenticated user's company
  if (!clientId && req.user) {
    clientId = req.user.company_id || (req.user.company_ids && req.user.company_ids[0]);
  }

  // 4. Fallback: Try to extract from Referer
  if (!clientId && req.headers.referer) {
    const referer = req.headers.referer;
    const match = referer.match(/\/client\/([^/]+)/);
    if (match) {
      clientId = match[1];
      console.log(`🔍 Recovered Client ID from Referer: ${clientId}`);
    }
  }

  // Final Validation: Ensure it's a valid UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (clientId && !uuidRegex.test(clientId)) {
    console.warn(`[checkQBAuth] Rejected invalid UUID: ${clientId}`);
    clientId = null;
  }

  // 5. QuickBooks requests must always be scoped to a selected DataHub company.
  if (!clientId) {
    return res.status(400).json({
      success: false,
      message:
        "Missing Client ID. QuickBooks requests must include the selected DataHub company.",
      isConnected: false,
    });
  }

  req.clientId = clientId;
  await loadQBConfig(clientId);

  const qb = getQBConfig(clientId);
  req.qb = qb;

  logQuickBooksDebug("route_qb_auth_check", {
    path: req.path,
    clientId,
    realmId: qb.realmId || null,
    hasAccessToken: Boolean(qb.accessToken),
    hasRefreshToken: Boolean(qb.refreshToken),
  });

  if (!qb || !qb.accessToken || !qb.realmId) {
    return res.status(401).json({
      success: false,
      message: `QuickBooks not connected for company ${clientId}`,
      isConnected: false,
    });
  }

  try {
    const result = await db.query("SELECT name FROM companies WHERE id = ?", [
      clientId,
    ]);
    const workspaceCompanyName = result?.rows?.[0]?.name || null;
    const quickbooksCompanyName = qb.companyName || null;
    const isMismatch =
      workspaceCompanyName &&
      quickbooksCompanyName &&
      normalizeCompanyName(workspaceCompanyName) !==
      normalizeCompanyName(quickbooksCompanyName);

    if (isMismatch) {
      console.warn(`[checkQBAuth] Company name mismatch detected (ignoring): Workspace "${workspaceCompanyName}" vs QuickBooks "${quickbooksCompanyName}"`);
    }

    // Proactive Token Refresh
    if (tokenManager.isTokenExpiring(qb.tokenExpiresAt)) {
      console.log(`[checkQBAuth] Token expiring for ${clientId}, refreshing...`);
      try {
        const newAccessToken = await tokenManager.refreshAccessToken(clientId);
        // Refresh local qb reference
        req.qb = getQBConfig(clientId);
        console.log(`[checkQBAuth] Token refreshed successfully for ${clientId}`);
      } catch (refreshError) {
        console.error(`[checkQBAuth] Proactive refresh failed for ${clientId}:`, refreshError.message);
        // If refresh fails, we might still have a partially valid token, but 401 is likely.
        // We'll let the request proceed and fail at the API level if needed, 
        // OR we can block it here. Blocking is safer.
        return res.status(401).json({
          success: false,
          message: "QuickBooks session expired and could not be refreshed. Please re-connect.",
          isConnected: false
        });
      }
    }
  } catch (error) {
    console.error("Company isolation check failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to validate company connection.",
    });
  }

  next();
}

function isQuickBooksRoute(pathname = "") {
  // Handle paths like /companies/uuid/qb-endpoint
  const normalizedPath = pathname.replace(/^\/companies\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "");
  
  const qbPaths = [
    "/balance-sheet",
    "/balance-sheet-detail",
    "/all-reports",
    "/general-ledger",
    "/profit-and-loss",
    "/profit-and-loss-detail",
    "/profit-and-loss-statement",
    "/customers",
    "/invoices",
    "/api/invoices",
    "/qb-transactions",
    "/qb-cashflow",
    "/qb-accounts",
    "/qb-cashflow-engine",
    "/qb-general-ledger",
    "/qb-reconciliation-transactions",
    "/qb-trial-balance",
    "/qb-reconciliation-engine",
    "/bank-transactions",
    "/bank-vs-books",
    "/reconciliation-data",
    "/reconciliation-variance",
    "/tax-reconciliation",
    "/refresh-token",
    "/qb-bank-accounts",
    "/qb-bank-activity",
    "/qb-one-bank-activity",
    "/api/extract-bank-pdf-records"
  ];

  return qbPaths.some(p => normalizedPath.startsWith(p) || pathname.startsWith(p));
}

function quickBooksAuth(req, res, next) {
  if (!isQuickBooksRoute(req.path)) {
    return next();
  }

  // Strip company prefix if present to allow standard route matching
  const prefixRegex = /^\/companies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const match = req.url.match(prefixRegex);
  if (match) {
    req.clientId = match[0].split("/")[2];
    req.url = req.url.replace(prefixRegex, "");
    if (req.url === "") req.url = "/";
  }

  // All QuickBooks routes require a valid user session
  return requireAuth(req, res, () => checkQBAuth(req, res, next));
}

app.use("/", quickBooksAuth, balanceSheetRoutes);
app.use("/", quickBooksAuth, balanceSheetDetailRoutes);
app.use("/", quickBooksAuth, generalLedgerRoutes);
app.use("/", quickBooksAuth, profitAndLossRoutes);
app.use("/", quickBooksAuth, profitAndLossStatementRoutes);
app.use("/", quickBooksAuth, customerFinanceRoutes);
app.use("/", quickBooksAuth, invoiceFinanceRoutes);
app.use("/", quickBooksAuth, cashflowRoutes);
app.use("/", quickBooksAuth, reconciliationRoutes);
app.use("/", quickBooksAuth, taxReconciliationRoutes);
app.use("/api", quickBooksAuth, bankVsBooksRoutes);
app.use("/", quickBooksAuth, bankStatementRoutes);
app.use("/", quickBooksAuth, bankVsBooksRoutes);
app.use("/", groupRoutes);
app.use("/", requestRoutes);
app.use("/", folderRoutes);
app.use("/", folderAccessRoutes);
app.use("/", reminderRoutes);
app.use("/", activityRoutes);
app.use("/", messageRoutes);

app.use(errorHandler);

module.exports = app;
