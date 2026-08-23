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

const COMPANY_PREFIX = /^\/companies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Does `router` itself define a handler for this method and path?
 *
 * This replaces a hand-maintained list of QuickBooks path prefixes. That list
 * was the authorization boundary for fifteen routers mounted at "/", and it
 * FAILED OPEN: `quickBooksAuth` called `next()` for anything not on it, and
 * these routers carry no other gate, so a path the list forgot reached its
 * handler unauthenticated. It had forgotten five, including
 * `PUT /api/customers/:id` — the list held `/customers` and `/api/invoices`
 * but never `/api/customers`.
 *
 * Asking the router what it serves cannot drift from what it serves. A route
 * added tomorrow is gated the moment it is defined, and the failure mode of a
 * mistake here is a 401 on a legitimate route rather than an open one.
 */
function routerHandles(router, method, path) {
  const verb = String(method || "").toLowerCase();
  return (router.stack || []).some((layer) => {
    if (!layer.route || typeof layer.match !== "function") return false;
    if (!layer.match(path)) return false;
    const methods = layer.route.methods || {};
    // Express dispatches HEAD to a GET handler when no HEAD route exists, so
    // gating on `methods.head` alone would leave every GET route reachable
    // unauthenticated by spelling the verb differently.
    return Boolean(methods[verb] || methods._all || (verb === "head" && methods.get));
  });
}

/**
 * Authenticate a QuickBooks router.
 *
 * Takes the router it guards, because these are all mounted at "/" and so see
 * every request in the app — including ones destined for messages, folders and
 * requests further down the chain. Those must pass through untouched, which is
 * why the middleware needs to know which paths belong to the router behind it.
 */
function quickBooksAuth(router) {
  if (!router || !Array.isArray(router.stack)) {
    throw new TypeError("quickBooksAuth(router) requires the router it guards");
  }

  return function quickBooksAuthMiddleware(req, res, next) {
    const match = req.url.match(COMPANY_PREFIX);
    const path = req.path.replace(COMPANY_PREFIX, "") || "/";

    if (!routerHandles(router, req.method, path)) {
      return next();
    }

    if (match) {
      req.clientId = match[1];
      const rewritten = req.url.replace(COMPANY_PREFIX, "");
      // "" for a bare company URL, "?x=1" when only a query survives.
      req.url = rewritten.startsWith("/") ? rewritten : `/${rewritten}`;
    }

    return requireAuth(req, res, () => checkQBAuth(req, res, next));
  };
}

module.exports = {
  quickBooksAuth,
  checkQBAuth,
  routerHandles
};
