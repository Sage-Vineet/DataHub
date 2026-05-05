const { supabase } = require("../db");

/**
 * QuickBooks Synced Reports Store
 * 
 * Handles CRUD operations for the `qb_synced_reports` table.
 * This table caches QB financial data so it can be served
 * when QuickBooks is disconnected.
 */

/**
 * Upsert a QB report into the database.
 * Uses ON CONFLICT on (company_id, report_type, report_params).
 * NEVER overwrites good data with error/empty payloads.
 */
async function upsertSyncedReport({ companyId, reportType, reportParams = {}, data }) {
  if (!companyId || !reportType) {
    throw new Error("upsertSyncedReport: companyId and reportType are required.");
  }

  // Safety: never cache error or empty payloads
  if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
    console.warn(`[SyncStore] Refusing to cache empty/invalid data for ${reportType} (company: ${companyId})`);
    return null;
  }

  const now = new Date().toISOString();

  const { data: row, error } = await supabase
    .from("qb_synced_reports")
    .upsert(
      {
        company_id: companyId,
        report_type: reportType,
        report_params: reportParams || {},
        data,
        source: "quickbooks",
        last_synced_at: now,
        updated_at: now,
      },
      { onConflict: "company_id,report_type,report_params" }
    )
    .select("id, company_id, report_type, last_synced_at")
    .single();

  if (error) {
    console.error(`[SyncStore] Failed to upsert report ${reportType}:`, error.message);
    throw error;
  }

  console.log(`[SyncStore] Cached ${reportType} for company ${companyId} at ${now}`);
  return row;
}

/**
 * Get a cached report from the database.
 * Returns the most recent entry matching company + report type.
 * Optionally matches report_params for param-specific caching.
 */
async function getCachedReport({ companyId, reportType, reportParams = null }) {
  if (!companyId || !reportType) return null;

  let query = supabase
    .from("qb_synced_reports")
    .select("*")
    .eq("company_id", companyId)
    .eq("report_type", reportType)
    .order("last_synced_at", { ascending: false })
    .limit(1);

  // If specific params requested, match them; otherwise get the most recent
  if (reportParams && Object.keys(reportParams).length > 0) {
    query = query.eq("report_params", reportParams);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    console.error(`[SyncStore] Failed to read cached ${reportType}:`, error.message);
    return null;
  }

  return data;
}

/**
 * Get all cached reports for a company.
 */
async function getAllCachedReports(companyId) {
  if (!companyId) return [];

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, company_id, report_type, report_params, last_synced_at, source")
    .eq("company_id", companyId)
    .order("last_synced_at", { ascending: false });

  if (error) {
    console.error("[SyncStore] Failed to list cached reports:", error.message);
    return [];
  }

  return data || [];
}

/**
 * Delete all cached reports for a company.
 * (Only used for full data cleanup, NOT on disconnect)
 */
async function deleteAllCachedReports(companyId) {
  if (!companyId) return false;

  const { error } = await supabase
    .from("qb_synced_reports")
    .delete()
    .eq("company_id", companyId);

  if (error) {
    console.error("[SyncStore] Failed to delete cached reports:", error.message);
    return false;
  }

  return true;
}

module.exports = {
  upsertSyncedReport,
  getCachedReport,
  getAllCachedReports,
  deleteAllCachedReports,
};
