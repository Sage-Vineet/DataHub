const dataSourceService = require("../services/dataSourceService");
const { REPORT_SOURCE_KEYS } = require("../services/reportSourceStore");
const { canAccessCompany } = require("../services/permissionService");

/**
 * Middleware to enforce that a specific data source is active for the current request.
 * Useful for blocking Manual GL operations when QuickBooks is active (and vice versa).
 * 
 * @param {string} requiredSourceKey - One of REPORT_SOURCE_KEYS
 */
function enforceDataSource(requiredSourceKey) {
  return async (req, res, next) => {
    try {
      // 1. Resolve clientId (companyId) from the request
      let clientId =
        req.clientId ||
        req.headers["x-client-id"] ||
        req.query.clientId ||
        (req.body && req.body.clientId) ||
        (req.params && req.params.clientId);

      // Secondary resolution logic from referer if needed (copied from manualGl.js pattern)
      if (!clientId && req.headers.referer) {
        const match =
          req.headers.referer.match(/\/client\/([^/]+)/) ||
          req.headers.referer.match(/\/workspace\/([^/]+)/);
        if (match) clientId = match[1];
      }

      if (!clientId) {
        // If we can't find a clientId, we let it proceed to let the actual route handle the missing param error
        return next();
      }

      if (req.user && !canAccessCompany(req.user, clientId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // 2. Validate using the service
      await dataSourceService.validateOperation(clientId, requiredSourceKey);

      next();
    } catch (error) {
      // 3. If validation fails, return 400 Bad Request
      res.status(409).json({
        success: false,
        error: error.message,
        code: error.code || "INCOMPATIBLE_DATA_SOURCE",
        message: error.message,
        requiresConfirmation: Boolean(error.requiresConfirmation),
        nextAction: error.nextAction || null,
        requestedSource: error.requestedSource || null,
        currentSource: error.currentSource || null,
      });
    }
  };
}

module.exports = {
  enforceDataSource,
  REPORT_SOURCE_KEYS
};
