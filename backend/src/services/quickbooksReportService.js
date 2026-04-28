const axios = require("axios");
const tokenManager = require("../tokenManager");
const { getQBConfig } = require("../qbconfig");
const { upsertSyncedReport, getCachedReport, getAllCachedReports } = require("./quickbooksSyncStore");

/**
 * QuickBooks Report Service
 * 
 * Orchestrates:
 *  1. Fetching reports from QuickBooks API
 *  2. Caching them to DB (qb_synced_reports)
 *  3. Serving cached data when QB is disconnected
 *  4. Full sync operations
 */

// Report type constants
const REPORT_TYPES = {
  PROFIT_AND_LOSS: "profit_and_loss",
  PROFIT_AND_LOSS_DETAIL: "profit_and_loss_detail",
  BALANCE_SHEET: "balance_sheet",
  BALANCE_SHEET_DETAIL: "balance_sheet_detail",
  CASH_FLOW: "cash_flow",
  GENERAL_LEDGER: "general_ledger",
  TRIAL_BALANCE: "trial_balance",
};

/**
 * Fetch a single report from QB API, cache it, and return it.
 * On API failure, falls back to cached data.
 * 
 * @param {string} clientId - DataHub company ID
 * @param {string} reportType - One of REPORT_TYPES
 * @param {string} qbReportName - QuickBooks API report name (e.g., "ProfitAndLoss")
 * @param {object} queryParams - Query parameters for the QB API call
 * @returns {{ data, source: 'live'|'cache', lastSyncedAt }}
 */
async function fetchAndCacheReport(clientId, reportType, qbReportName, queryParams = {}) {
  const qb = getQBConfig(clientId);

  if (!qb || !qb.accessToken || !qb.realmId) {
    // QB not connected — try cache
    return serveCachedReport(clientId, reportType, queryParams);
  }

  // Build QB API URL
  const params = { ...queryParams, minorversion: 75 };
  const url = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/${qbReportName}`;

  try {
    const response = await fetchWithTokenRetry(clientId, url, params);

    // Validate response before caching
    if (response.data && typeof response.data === "object") {
      // Cache to DB (fire-and-forget, don't block response)
      upsertSyncedReport({
        companyId: clientId,
        reportType,
        reportParams: sanitizeParams(queryParams),
        data: response.data,
      }).catch(err => {
        console.error(`[ReportService] Background cache failed for ${reportType}:`, err.message);
      });
    }

    return {
      data: response.data,
      source: "live",
      lastSyncedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn(`[ReportService] Live fetch failed for ${reportType}, trying cache...`, error.message);

    // Fallback to cache
    const cached = await serveCachedReport(clientId, reportType, queryParams);
    if (cached) return cached;

    // No cache available — re-throw
    throw error;
  }
}

/**
 * Serve a report from the DB cache.
 */
async function serveCachedReport(clientId, reportType, queryParams = {}) {
  const cached = await getCachedReport({
    companyId: clientId,
    reportType,
    reportParams: sanitizeParams(queryParams),
  });

  if (!cached) {
    // Try without params (get any cached version)
    const anyCached = await getCachedReport({
      companyId: clientId,
      reportType,
    });

    if (anyCached) {
      return {
        data: anyCached.data,
        source: "cache",
        lastSyncedAt: anyCached.last_synced_at,
        cachedParams: anyCached.report_params,
      };
    }

    return null;
  }

  return {
    data: cached.data,
    source: "cache",
    lastSyncedAt: cached.last_synced_at,
  };
}

/**
 * Fetch with automatic token refresh retry on 401.
 */
async function fetchWithTokenRetry(clientId, url, params) {
  const qb = getQBConfig(clientId);

  try {
    return await axios.get(url, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
      },
      params,
    });
  } catch (error) {
    if (error.response?.status === 401) {
      console.log(`[ReportService] Token expired for ${clientId}, refreshing...`);
      const newAccessToken = await tokenManager.refreshAccessToken(clientId);

      return await axios.get(url, {
        headers: {
          Authorization: `Bearer ${newAccessToken}`,
          Accept: "application/json",
        },
        params,
      });
    }
    throw error;
  }
}

/**
 * Fetch a QB query endpoint (for transactions, accounts, etc.)
 */
async function fetchAndCacheQuery(clientId, reportType, queryString, queryParams = {}) {
  const qb = getQBConfig(clientId);

  if (!qb || !qb.accessToken || !qb.realmId) {
    return serveCachedReport(clientId, reportType, queryParams);
  }

  const url = `${qb.baseUrl}/v3/company/${qb.realmId}/query`;

  try {
    const response = await fetchQueryWithRetry(clientId, url, queryString);

    if (response.data) {
      upsertSyncedReport({
        companyId: clientId,
        reportType,
        reportParams: sanitizeParams(queryParams),
        data: response.data,
      }).catch(err => {
        console.error(`[ReportService] Background cache failed for ${reportType}:`, err.message);
      });
    }

    return {
      data: response.data,
      source: "live",
      lastSyncedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn(`[ReportService] Live query failed for ${reportType}, trying cache...`);
    const cached = await serveCachedReport(clientId, reportType, queryParams);
    if (cached) return cached;
    throw error;
  }
}

async function fetchQueryWithRetry(clientId, url, queryString) {
  const qb = getQBConfig(clientId);

  const makeRequest = (token) => axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    params: {
      query: queryString,
      minorversion: 75,
    },
  });

  try {
    return await makeRequest(qb.accessToken);
  } catch (error) {
    if (error.response?.status === 401) {
      const newToken = await tokenManager.refreshAccessToken(clientId);
      return await makeRequest(newToken);
    }
    throw error;
  }
}

/**
 * Full sync: fetch and cache all core reports for a company.
 * Returns a summary of what was synced.
 */
async function syncAllReports(clientId) {
  const results = {};
  const errors = [];

  const reportsToSync = [
    { type: REPORT_TYPES.PROFIT_AND_LOSS, qbName: "ProfitAndLoss" },
    { type: REPORT_TYPES.BALANCE_SHEET, qbName: "BalanceSheet" },
    { type: REPORT_TYPES.CASH_FLOW, qbName: "CashFlow" },
  ];

  for (const report of reportsToSync) {
    try {
      const result = await fetchAndCacheReport(clientId, report.type, report.qbName);
      results[report.type] = {
        success: true,
        source: result.source,
        lastSyncedAt: result.lastSyncedAt,
      };
    } catch (error) {
      console.error(`[ReportService] Sync failed for ${report.type}:`, error.message);
      errors.push({ reportType: report.type, error: error.message });
      results[report.type] = {
        success: false,
        error: error.message,
      };
    }
  }

  return {
    companyId: clientId,
    syncedAt: new Date().toISOString(),
    results,
    errors,
    hasErrors: errors.length > 0,
  };
}

/**
 * Get sync status for a company (what's cached and when).
 */
async function getSyncStatus(clientId) {
  const reports = await getAllCachedReports(clientId);

  return {
    companyId: clientId,
    totalCachedReports: reports.length,
    reports: reports.map(r => ({
      reportType: r.report_type,
      lastSyncedAt: r.last_synced_at,
      source: r.source,
    })),
    lastSyncedAt: reports.length > 0 ? reports[0].last_synced_at : null,
  };
}

/**
 * Sanitize query params for consistent DB matching.
 * Removes undefined/null values and sorts keys.
 */
function sanitizeParams(params) {
  if (!params || typeof params !== "object") return {};

  const cleaned = {};
  const sortedKeys = Object.keys(params).sort();

  for (const key of sortedKeys) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
      // Strip internal params that shouldn't be part of cache key
      if (key === "clientId" || key === "minorversion") continue;
      cleaned[key] = String(params[key]);
    }
  }

  return cleaned;
}

module.exports = {
  REPORT_TYPES,
  fetchAndCacheReport,
  fetchAndCacheQuery,
  serveCachedReport,
  syncAllReports,
  getSyncStatus,
};
