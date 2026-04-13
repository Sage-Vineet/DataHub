const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { errorHandler } = require("./middleware/error");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const companyRoutes = require("./routes/companies");
const groupRoutes = require("./routes/groups");
const requestRoutes = require("./routes/requests");
const folderRoutes = require("./routes/folders");
const folderAccessRoutes = require("./routes/folderAccess");
const reminderRoutes = require("./routes/reminders");
const activityRoutes = require("./routes/activity");
const uploadRoutes = require("./routes/uploads");
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
const bankStatementRoutes = require("./routes/quickbooks/reconciliation/bankStatement");
const bankVsBooksRoutes = require("./routes/quickbooks/reconciliation/bankVsBooks");
const db = require("./db");
const { getQBConfig, disconnectConfig } = require("./qbconfig");

const app = express();

const allowedOrigins = Array.from(
  new Set(
    [
      process.env.FRONTEND_URL,
      process.env.APP_URL,
      process.env.CORS_ORIGIN,
      "https://datahub-final-v1.vercel.app",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:5174",
      "http://127.0.0.1:5175",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]
      .filter(Boolean)
      .map((origin) => origin.replace(/\/$/, "")),
  ),
);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = origin.replace(/\/$/, "");

    if (allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    console.error(`CORS blocked origin: ${origin}`);
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-client-id"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    message: "Backend is running",
  });
});

app.use("/auth", authRoutes);
app.use("/users", userRoutes);
app.use("/companies", companyRoutes);
app.use("/", tokenRoutes);
app.use("/", uploadRoutes);

function normalizeCompanyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function checkQBAuth(req, res, next) {
  let clientId = req.headers["x-client-id"];

  if (!clientId && req.query.clientId) {
    clientId = req.query.clientId;
  }

  if (!clientId && req.headers.referer) {
    const referer = req.headers.referer;
    const match = referer.match(/\/client\/([^/]+)/);

    if (match) {
      clientId = match[1];
      console.log(`Recovered Client ID from Referer: ${clientId}`);
    }
  }

  if (!clientId) {
    console.warn(
      "Client ID missing in request. Attempting to use default connection.",
    );
  }

  req.clientId = clientId;

  const qb = getQBConfig(clientId);

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
      disconnectConfig(clientId);

      return res.status(401).json({
        success: false,
        isConnected: false,
        isNameMismatch: true,
        message: `Company mismatch: selected workspace "${workspaceCompanyName}" does not match QuickBooks company "${quickbooksCompanyName}". Connection blocked.`,
      });
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
  return (
    pathname.startsWith("/balance-sheet") ||
    pathname.startsWith("/balance-sheet-detail") ||
    pathname.startsWith("/all-reports") ||
    pathname.startsWith("/general-ledger") ||
    pathname.startsWith("/profit-and-loss") ||
    pathname.startsWith("/profit-and-loss-detail") ||
    pathname.startsWith("/profit-and-loss-statement") ||
    pathname.startsWith("/customers") ||
    pathname.startsWith("/invoices") ||
    pathname.startsWith("/api/invoices") ||
    pathname.startsWith("/qb-transactions") ||
    pathname.startsWith("/qb-cashflow") ||
    pathname.startsWith("/qb-accounts") ||
    pathname.startsWith("/qb-cashflow-engine") ||
    pathname.startsWith("/qb-general-ledger") ||
    pathname.startsWith("/qb-reconciliation-transactions") ||
    pathname.startsWith("/qb-trial-balance") ||
    pathname.startsWith("/qb-reconciliation-engine") ||
    pathname.startsWith("/bank-transactions") ||
    pathname.startsWith("/bank-vs-books") ||
    pathname.startsWith("/reconciliation-data") ||
    pathname.startsWith("/reconciliation-variance") ||
    pathname.startsWith("/refresh-token")
  );
}

function quickBooksAuth(req, res, next) {
  if (!isQuickBooksRoute(req.path)) {
    return next();
  }

  return checkQBAuth(req, res, next);
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
app.use("/", quickBooksAuth, bankStatementRoutes);
app.use("/", quickBooksAuth, bankVsBooksRoutes);
app.use("/", groupRoutes);
app.use("/", requestRoutes);
app.use("/", folderRoutes);
app.use("/", folderAccessRoutes);
app.use("/", reminderRoutes);
app.use("/", activityRoutes);

app.use(errorHandler);

module.exports = app;