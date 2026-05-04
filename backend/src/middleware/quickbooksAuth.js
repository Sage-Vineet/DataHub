const { getQBConfig, loadQBConfig } = require("../qbconfig");
const { logQuickBooksDebug } = require("../quickbooksLogger");
const tokenManager = require("../tokenManager");
const { requireAuth } = require("./auth");
const { supabase } = require("../db");

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
    }
  }

  // Final Validation: Ensure it's a valid UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (clientId && !uuidRegex.test(clientId)) {
    clientId = null;
  }

  if (!clientId) {
    return res.status(400).json({
      success: false,
      message: "Missing Client ID. QuickBooks requests must include the selected DataHub company.",
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
    // QB not connected — mark as disconnected and let route handle fallback
    req.qbDisconnected = true;
    logQuickBooksDebug("route_qb_disconnected_fallback", {
      path: req.path,
      clientId,
      message: "QB not connected, route will attempt cached data fallback",
    });
    return next();
  }

  try {
    // Proactive Token Refresh
    if (tokenManager.isTokenExpiring(qb.tokenExpiresAt)) {
      try {
        await tokenManager.refreshAccessToken(clientId);
        req.qb = getQBConfig(clientId);
      } catch (refreshError) {
        // Token refresh failed — mark as disconnected for fallback
        req.qbDisconnected = true;
        logQuickBooksDebug("route_qb_token_refresh_failed_fallback", {
          path: req.path,
          clientId,
          message: "Token refresh failed, route will attempt cached data fallback",
        });
        return next();
      }
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Unable to validate company connection.",
    });
  }

  req.qbDisconnected = false;
  next();
}

function isQuickBooksRoute(pathname = "") {
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
    "/extract-bank-pdf-records",
    "/quickbooks-pl",
    "/tax-data",
    "/qb-profit-loss-detail",
    "/qb-balance-sheet",
    "/qb-financial-reports-for-reconciliation",
    "/parse-bank-statement",
    "/api/quickbooks/sync",
    "/api/quickbooks/sync-status"
  ];

  return qbPaths.some(p => normalizedPath.startsWith(p) || pathname.startsWith(p));
}

function quickBooksAuth(req, res, next) {
  if (!isQuickBooksRoute(req.path)) {
    return next();
  }

  const prefixRegex = /^\/companies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const match = req.url.match(prefixRegex);
  if (match) {
    req.clientId = match[1];
    req.url = req.url.replace(prefixRegex, "");
    if (req.url === "") req.url = "/";
  }

  return requireAuth(req, res, () => checkQBAuth(req, res, next));
}

module.exports = {
  quickBooksAuth,
  checkQBAuth,
  isQuickBooksRoute
};
