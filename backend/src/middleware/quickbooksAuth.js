const { getQBConfig, loadQBConfig } = require("../qbconfig");
const { logQuickBooksDebug } = require("../quickbooksLogger");
const tokenManager = require("../tokenManager");
const { requireAuth } = require("./auth");
const { supabase } = require("../db");
const { canAccessCompany } = require("../services/permissionService");

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

  if (!canAccessCompany(req.user, clientId)) {
    return res.status(403).json({
      success: false,
      message: "Access denied.",
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
    "/bank-reconciliation-line-items",
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

/**
 * Routes served by the financial routers that legitimately need no
 * authentication. This is an explicit, closed list — everything else is
 * authenticated.
 *
 * `/api/auth/callback` is the QuickBooks OAuth 2.0 redirect URI. Intuit calls it
 * directly with no bearer token, so it cannot require one; it is protected
 * instead by the signed `state` parameter, which the handler must verify to bind
 * the callback to the session that started the flow. That check lives in
 * routes/quickbooks/token.js.
 */
const UNAUTHENTICATED_PATHS = new Set(["/api/auth/callback"]);

const COMPANY_PREFIX_RE =
  /^\/companies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Rewrites `/companies/<uuid>/balance-sheet` to `/balance-sheet`, stashing the
 * company id on the request. Mounted once, ahead of the financial routers.
 */
function extractCompanyPrefix(req, _res, next) {
  const match = req.url.match(COMPANY_PREFIX_RE);
  if (match) {
    req.clientId = match[1];
    req.url = req.url.replace(COMPANY_PREFIX_RE, "");
    if (req.url === "" || req.url.startsWith("?")) req.url = `/${req.url}`;
  }
  return next();
}

/**
 * Decides whether a given router owns the incoming request.
 *
 * WHY this is derived from the router's own stack rather than a hand-written
 * path list: the previous implementation gated authentication on a hardcoded
 * array of path prefixes, and every route added to these routers without a
 * matching array entry became a publicly accessible endpoint. `PUT
 * /api/customers/:id` was live and unauthenticated for exactly that reason.
 * Reading the registered layers means a new route is covered automatically.
 *
 * Fails safe: anything it cannot positively classify is treated as owned, which
 * results in authentication being required (worst case: a 401 instead of a 404).
 */
function routerOwnsRequest(router, req) {
  const stack = router?.stack;
  if (!Array.isArray(stack)) return true;

  const method = req.method.toLowerCase();
  for (const layer of stack) {
    if (!layer.route) {
      // A non-route layer (router.use) can match anything — assume ownership.
      return true;
    }
    let matched = false;
    try {
      matched = layer.match(req.path);
    } catch {
      return true;
    }
    if (!matched) continue;
    const methods = layer.route.methods || {};
    if (methods[method] || methods.all || method === "options") return true;
  }
  return false;
}

/**
 * Authentication gate for the QuickBooks / financial routers — default deny.
 *
 * Every request these routers will handle is authenticated, unless its path is
 * on the explicit UNAUTHENTICATED_PATHS list. `isQuickBooksRoute` survives only
 * to decide whether the QuickBooks *connection* context needs loading, which is
 * a functional concern rather than a security one.
 *
 * @param {import('express').Router} router the router this guard protects
 */
function guardFinancialRouter(router) {
  return function quickBooksRouteGuard(req, res, next) {
    // Not ours — hand straight on so unrelated routes are unaffected.
    if (!routerOwnsRequest(router, req)) return next();

    if (UNAUTHENTICATED_PATHS.has(req.path)) return next();

    return requireAuth(req, res, (err) => {
      if (err) return next(err);
      if (!isQuickBooksRoute(req.path)) return next();
      return checkQBAuth(req, res, next);
    });
  };
}

/**
 * Standalone guard for callers that mount a single financial route directly.
 * Authenticates unconditionally (minus the OAuth callback).
 */
function quickBooksAuth(req, res, next) {
  if (UNAUTHENTICATED_PATHS.has(req.path)) return next();
  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (!isQuickBooksRoute(req.path)) return next();
    return checkQBAuth(req, res, next);
  });
}

module.exports = {
  quickBooksAuth,
  guardFinancialRouter,
  extractCompanyPrefix,
  checkQBAuth,
  isQuickBooksRoute,
};
