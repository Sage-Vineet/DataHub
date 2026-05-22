/**
 * activationService.js
 *
 * Single authority for all dataset version activation/deactivation.
 * Consolidates the two previous split-brain activation paths:
 *   - datasetVersionService.activateDatasetVersion (Manual GL)
 *   - quickbooksSyncStore.setActiveDataset (QuickBooks)
 *
 * All source types converge here. Downstream callers must NOT call the
 * individual activation functions directly.
 *
 * Key invariants:
 *   1. Only ONE active version per (company, source_type) at any time
 *   2. Activation is scoped by source_type — never cross-contaminates
 *   3. reportCache is invalidated on every activation
 *   4. active_fiscal_years MV is refreshed after every activation
 *   5. Activation events are logged for audit
 *   6. companies.active_dataset_version_id is kept in sync
 */

const { supabase } = require("../db");
const reportCache = require("./reportCache");
const {
    activateDatasetVersion: legacyActivate,
    activateFiscalYears,
    getDatasetVersion,
    findActiveVersionByHash,
} = require("./datasetVersionService");

const ACTIVATION_SOURCE_TYPES = Object.freeze({
    MANUAL_GL: "manual_gl_upload",
    QUICKBOOKS: "quickbooks_online",
    MANUAL_UPLOAD: "manual_upload_excel_pdf",
    QUICKBOOKS_MANUAL: "quickbooks_manual",
});

function resolveSourceType(version) {
    return version?.source_type
        || version?.upload_source?.includes("quickbooks") ? "quickbooks_online"
        : version?.upload_source?.includes("manual") ? "manual_gl_upload"
        : "manual_gl_upload";
}

/**
 * Activate a dataset version transactionally.
 *
 * Steps:
 *   1. Validate the version exists and belongs to the company
 *   2. Call the scope-aware RPC (activate_dataset_version_scoped)
 *   3. Update companies.active_dataset_version_id
 *   4. Invalidate report cache for this company+source
 *   5. Refresh the active_fiscal_years materialized view
 *   6. Return the activated version
 */
/**
 * Activate a dataset version.
 *
 * When `options.fiscalYears` is provided, activation is FISCAL-YEAR-SCOPED:
 * the bridge table (dataset_version_fiscal_years) is updated for only those
 * years, leaving other fiscal years on their previously active versions.
 * This is the CORRECT behavior for partial uploads.
 *
 * When `options.fiscalYears` is NOT provided, the old monolithic behavior
 * is preserved for backward compatibility (deactivates ALL other versions
 * for the same source type).
 */
async function activateSnapshot(companyId, versionId, options = {}) {
    if (!companyId || !versionId) {
        throw new Error("Both companyId and versionId are required for activation.");
    }

    const sourceType = options.sourceType || null;
    const fiscalYears = options.fiscalYears || null;

    // 1. Validate version
    const version = await getDatasetVersion(versionId);
    if (!version || version.company_id !== companyId) {
        throw new Error(`Version ${versionId} not found for company ${companyId}.`);
    }

    const effectiveSourceType = sourceType || resolveSourceType(version);
    const now = new Date().toISOString();

    if (fiscalYears && fiscalYears.length > 0) {
        // ── FISCAL-YEAR-SCOPED ACTIVATION ────────────────────────────────
        // Only the specified fiscal years are moved to this version.
        // Other fiscal years remain on their currently active version.
        console.log(
            `[ActivationService] Fiscal-year-scoped activation of version ${versionId} ` +
            `for fiscal years [${fiscalYears.join(", ")}], company ${companyId}`
        );

        await activateFiscalYears(companyId, versionId, fiscalYears, effectiveSourceType);

        // Update companies.active_dataset_version_id to the latest version
        const companyPatch = {
            active_dataset_version_id: versionId,
            active_dataset_activated_at: now,
            updated_at: now,
        };
        if (effectiveSourceType) {
            companyPatch.data_source_type = effectiveSourceType;
        }

        const { error: companyUpdateError } = await supabase
            .from("companies")
            .update(companyPatch)
            .eq("id", companyId);

        if (companyUpdateError) {
            console.warn(
                "[ActivationService] Failed to update company active_dataset_version_id:",
                companyUpdateError.message
            );
        }
    } else {
        // ── MONOLITHIC ACTIVATION (backward compatible) ──────────────────
        console.log(
            `[ActivationService] Monolithic activation of version ${versionId} ` +
            `for company ${companyId}, source=${effectiveSourceType}`
        );

        // 2. Call scope-aware RPC
        try {
            const { data: rpcResult, error: rpcError } = await supabase
                .rpc("activate_dataset_version_scoped", {
                    p_company_id: companyId,
                    p_version_id: versionId,
                    p_source_type: effectiveSourceType,
                });

            if (rpcError) {
                console.warn(
                    "[ActivationService] activate_dataset_version_scoped RPC failed, " +
                    "falling back to legacy activation:",
                    rpcError.message
                );
                await legacyActivate(companyId, versionId);
            }
        } catch (rpcError) {
            console.warn(
                "[ActivationService] RPC error, falling back to legacy activation:",
                rpcError.message
            );
            await legacyActivate(companyId, versionId);
        }

        // 3. Update companies.active_dataset_version_id
        const companyPatch = {
            active_dataset_version_id: versionId,
            active_dataset_activated_at: now,
            updated_at: now,
        };
        if (effectiveSourceType) {
            companyPatch.data_source_type = effectiveSourceType;
        }

        const { error: companyUpdateError } = await supabase
            .from("companies")
            .update(companyPatch)
            .eq("id", companyId);

        if (companyUpdateError) {
            console.warn(
                "[ActivationService] Failed to update company active_dataset_version_id:",
                companyUpdateError.message
            );
        }

        // For monolithic activation, also sync bridge table for all years
        if (version.fiscal_years && version.fiscal_years.length > 0) {
            try {
                await activateFiscalYears(companyId, versionId, version.fiscal_years, effectiveSourceType);
            } catch (bridgeError) {
                console.warn("[ActivationService] Failed to sync bridge table after monolithic activation:", bridgeError.message);
            }
        }
    }

    // 4. Invalidate report cache for this company+source
    reportCache.invalidateCompany(companyId);

    // 5. Refresh active_fiscal_years materialized view (async, non-blocking)
    refreshActiveFiscalYears().catch((err) => {
        console.warn("[ActivationService] Failed to refresh active_fiscal_years:", err.message);
    });

    // 6. Fire events for connected frontends
    if (typeof global !== "undefined" && global.process) {
      try {
        const { emitWorkspaceDataSourceUpdated } = require("../../src/lib/dataSourceEvents");
        emitWorkspaceDataSourceUpdated({
          clientId: companyId,
          sourceKey: effectiveSourceType,
          timestamp: now,
        });
      } catch (_) {
        // Frontend event emission is best-effort
      }
    }

    console.log(
        `[ActivationService] ✅ Activated version ${versionId} for company ${companyId}`
    );

    return { version, sourceType: effectiveSourceType, activatedAt: now };
}

/**
 * Deactivate all versions for a source type without activating a replacement.
 * Used when switching away from a source entirely.
 */
async function deactivateSource(companyId, sourceType) {
    if (!companyId || !sourceType) {
        throw new Error("Both companyId and sourceType are required.");
    }

    console.log(
        `[ActivationService] Deactivating source ${sourceType} for company ${companyId}`
    );

    const { error } = await supabase
        .from("dataset_versions")
        .update({ is_active: false })
        .eq("company_id", companyId)
        .eq("is_active", true)
        .eq("source_type", sourceType);

    if (error) {
        throw new Error(`Failed to deactivate source ${sourceType}: ${error.message}`);
    }

    reportCache.invalidateCompany(companyId);
    refreshActiveFiscalYears().catch((err) => {
        console.warn("[ActivationService] Failed to refresh active_fiscal_years:", err.message);
    });

    console.log(
        `[ActivationService] ✅ Deactivated source ${sourceType} for company ${companyId}`
    );
}

/**
 * Check if a dataset with the same content hash is already active.
 * Used for idempotent duplicate detection.
 */
async function isDuplicateDataset(companyId, contentHash, sourceType = null) {
    if (!companyId || !contentHash) return false;

    const existing = await findActiveVersionByHash(companyId, contentHash, sourceType);
    return Boolean(existing);
}

/**
 * Refresh the active_fiscal_years materialized view.
 * Called after every activation so the fiscal year dropdown always shows
 * only years from the active snapshot.
 */
async function refreshActiveFiscalYears() {
    const { error } = await supabase.rpc("refresh_active_fiscal_years");
    if (error) {
        // Fallback: direct REFRESH
        const { error: refreshError } = await supabase
            .rpc("refresh_mat_view", { view_name: "active_fiscal_years" });

        if (refreshError) {
            // Last resort: try direct SQL refresh
            try {
                await supabase.query("REFRESH MATERIALIZED VIEW CONCURRENTLY active_fiscal_years");
            } catch (sqlError) {
                console.warn(
                    "[ActivationService] Could not refresh active_fiscal_years:",
                    sqlError.message
                );
            }
        }
    }
}

/**
 * Get the active dataset version ID for a company+source from the companies
 * table (the single authoritative source).
 */
async function getActiveDatasetVersionId(companyId, sourceType = null) {
    if (!companyId) return null;

    const { data, error } = await supabase
        .from("companies")
        .select("active_dataset_version_id")
        .eq("id", companyId)
        .maybeSingle();

    if (error || !data?.active_dataset_version_id) {
        // Fallback: query dataset_versions directly
        let query = supabase
            .from("dataset_versions")
            .select("id")
            .eq("company_id", companyId)
            .eq("is_active", true)
            .eq("status", "finalized")
            .order("version_number", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (sourceType) {
            query = query.eq("source_type", sourceType);
        }

        const { data: fallback, error: fallbackError } = await query;
        if (fallbackError || !fallback) return null;
        return fallback.id;
    }

    return data.active_dataset_version_id;
}

module.exports = {
    ACTIVATION_SOURCE_TYPES,
    activateSnapshot,
    deactivateSource,
    isDuplicateDataset,
    refreshActiveFiscalYears,
    getActiveDatasetVersionId,
};
