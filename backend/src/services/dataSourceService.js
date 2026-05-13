const { supabase } = require("../db");
const {
  REPORT_SOURCE_KEYS,
  setSelectedReportSource,
  syncReportSourceRecords,
} = require("./reportSourceStore");
const { softDisconnectQuickBooks } = require("./quickbooksConnectionStore");
const {
  normalizeDataSourceKey,
  isSupportedDataSourceKey,
} = require("./dataSourceRegistry");

function normalizeSourceKey(value, fallback = null) {
  return normalizeDataSourceKey(value, fallback);
}

function createSourceError(message, code, extras = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extras);
  return error;
}

function isConfirmationProvided(options = {}) {
  return options?.confirmSwitch === true || options?.confirmSwitch === "true";
}

function resolveSelectedSource(sources = []) {
  return (sources || []).find((source) => source?.isSelected)?.sourceKey || null;
}

/**
 * DataSourceService
 * Centralizes logic for managing active data sources (QuickBooks vs Manual GL).
 */
class DataSourceService {
  async getCompanySourceState(companyId) {
    if (!companyId) return null;

    const { data: company, error } = await supabase
      .from("companies")
      .select("*")
      .eq("id", companyId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load company source state: ${error.message}`);
    }

    return company || null;
  }

  async getQuickBooksConnectionState(companyId) {
    if (!companyId) return { isConnected: false, realmId: null };

    const { data, error } = await supabase
      .from("quickbooks_connections")
      .select("*")
      .eq("company_id", companyId)
      .maybeSingle();

    if (error && error.code !== "PGRST116") {
      throw new Error(`Failed to load QuickBooks connection state: ${error.message}`);
    }

    const isConnected = Boolean(data?.realm_id) && data?.is_connected !== false;
    return {
      isConnected,
      realmId: data?.realm_id || null,
    };
  }

  async updateCompanySourceState(companyId, patch = {}) {
    if (!companyId) return null;

    const nextPatch = {
      ...patch,
      updated_at: new Date().toISOString(),
    };

    const attemptPatch = async (payload) => supabase
      .from("companies")
      .update(payload)
      .eq("id", companyId);

    let payload = { ...nextPatch };
    let lastError = null;
    let lastErrorWasMissingColumn = false;

    while (Object.keys(payload).length > 1) {
      const { error } = await attemptPatch(payload);
      if (!error) return true;
      lastError = error;

      // PostgREST may quote column names with single or double quotes depending on version/error type:
      //   column "last_source_switch_at" does not exist          (PostgreSQL-level)
      //   Column 'last_source_switch_at' of relation '...' does not exist (PostgREST schema-cache)
      //   Could not find column 'last_source_switch_at' in the schema cache
      const missingColumnMatch = String(error.message || "").match(
        /column\s+['"]([^'"]+)['"]/i,
      );
      const missingColumn = missingColumnMatch?.[1];
      if (!missingColumn || !Object.prototype.hasOwnProperty.call(payload, missingColumn)) {
        lastErrorWasMissingColumn = false;
        break;
      }

      console.warn(
        `[DataSourceService] Column "${missingColumn}" missing from companies table — stripping and retrying.`,
        { companyId, missingColumn, error: error.message },
      );
      lastErrorWasMissingColumn = true;
      delete payload[missingColumn];
    }

    if (lastError && !lastErrorWasMissingColumn) {
      throw new Error(`Failed to update company source state: ${lastError.message}`);
    }

    return false;
  }

  /**
   * Lightweight read of the current active source — reads only the companies row
   * and the QuickBooks connection row, avoiding the expensive syncReportSourceRecords.
   * Used internally by switchDataSource to determine the current state before switching.
   */
  async _getCurrentSourceLightweight(companyId) {
    const [company, qbConnection] = await Promise.all([
      this.getCompanySourceState(companyId),
      this.getQuickBooksConnectionState(companyId),
    ]);

    const activeSource =
      normalizeSourceKey(company?.data_source_type) || REPORT_SOURCE_KEYS.QUICKBOOKS;

    return {
      activeSource,
      quickbooksConnected:
        Boolean(company?.quickbooks_connected) || qbConnection.isConnected,
      manualUploadActive: activeSource === REPORT_SOURCE_KEYS.MANUAL_GL,
      lastSourceSwitchAt: company?.last_source_switch_at || null,
    };
  }

  async getDataSourceState(companyId) {
    if (!companyId) {
      return {
        activeSource: null,
        quickbooksConnected: false,
        manualUploadActive: false,
        lastSourceSwitchAt: null,
        sources: [],
      };
    }

    let sources = await syncReportSourceRecords(companyId);
    const company = await this.getCompanySourceState(companyId);
    const quickBooksConnection = await this.getQuickBooksConnectionState(companyId);

    const selectedSource = resolveSelectedSource(sources);
    const companySource = normalizeSourceKey(company?.data_source_type);
    const activeSource =
      companySource || selectedSource || REPORT_SOURCE_KEYS.QUICKBOOKS;

    if (activeSource && selectedSource !== activeSource) {
      sources = await setSelectedReportSource(companyId, activeSource);
    }

    const quickbooksRecord = sources.find(
      (source) => source.sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS,
    );
    const quickbooksConnected = Boolean(
      quickbooksRecord?.isConnected ||
      quickBooksConnection.isConnected ||
      company?.quickbooks_connected,
    );
    const manualUploadActive = activeSource === REPORT_SOURCE_KEYS.MANUAL_GL;

    return {
      activeSource,
      quickbooksConnected,
      manualUploadActive,
      lastSourceSwitchAt: company?.last_source_switch_at || null,
      sources,
    };
  }

  /**
   * Get the active data source key for a company.
   */
  async getActiveDataSource(companyId) {
    const state = await this.getDataSourceState(companyId);
    return state.activeSource;
  }

  /**
   * Switch the active data source.
   * Uses a lightweight current-source read to avoid redundant syncReportSourceRecords
   * calls during the pre-switch state check, then performs a single authoritative sync
   * after the switch.
   */
  async switchDataSource(companyId, targetSourceKey, options = {}) {
    const switchStart = Date.now();

    if (!companyId) throw new Error("companyId is required");

    const normalizedTargetSource = normalizeSourceKey(targetSourceKey);
    if (!isSupportedDataSourceKey(normalizedTargetSource)) {
      throw createSourceError(
        `Invalid source key: ${targetSourceKey}`,
        "INVALID_SOURCE_KEY",
      );
    }

    // Lightweight read — no full sync, just companies + QB connection rows.
    const currentState = await this._getCurrentSourceLightweight(companyId);
    const currentSource = currentState.activeSource;
    const confirmSwitch = isConfirmationProvided(options);
    const forceDisconnectQuickbooks = Boolean(options.forceDisconnectQuickbooks);

    console.info("[DataSourceService] switchDataSource called", {
      companyId,
      currentSource,
      targetSource: normalizedTargetSource,
      confirmSwitch,
      forceDisconnectQuickbooks,
    });

    if (currentSource === normalizedTargetSource) {
      // Already on the target source — just return a fresh sync.
      const refreshedSources = await syncReportSourceRecords(companyId);
      const durationMs = Date.now() - switchStart;
      console.info("[DataSourceService] switchDataSource: already on target, refreshed", {
        companyId, source: normalizedTargetSource, durationMs,
      });
      return {
        success: true,
        activeSource: normalizedTargetSource,
        sources: refreshedSources,
        quickbooksConnected: currentState.quickbooksConnected,
      };
    }

    if (currentSource && !confirmSwitch) {
      throw createSourceError(
        "Source switch confirmation is required.",
        "SOURCE_SWITCH_CONFIRMATION_REQUIRED",
        {
          requiresConfirmation: true,
          nextAction:
            normalizedTargetSource === REPORT_SOURCE_KEYS.MANUAL_GL
              ? "switch_to_manual"
              : "switch_to_quickbooks",
          requestedSource: normalizedTargetSource,
          currentSource,
        },
      );
    }

    if (normalizedTargetSource === REPORT_SOURCE_KEYS.MANUAL_GL) {
      if (currentState.quickbooksConnected && forceDisconnectQuickbooks) {
        await softDisconnectQuickBooks(companyId);
      }
    }

    // Update report_source_records selection + do a single authoritative sync.
    const updatedSources = await setSelectedReportSource(companyId, normalizedTargetSource);

    // Update the QB connection state after any potential soft-disconnect.
    const quickbooksStateAfterSwitch = await this.getQuickBooksConnectionState(companyId);

    // Persist source switch to the companies row (resilient to missing columns).
    const dbResult = await this.updateCompanySourceState(companyId, {
      data_source_type: normalizedTargetSource,
      quickbooks_connected: quickbooksStateAfterSwitch.isConnected,
      manual_upload_active: normalizedTargetSource === REPORT_SOURCE_KEYS.MANUAL_GL,
      last_source_switch_at: new Date().toISOString(),
    });

    const durationMs = Date.now() - switchStart;
    console.info("[DataSourceService] switchDataSource: completed", {
      companyId,
      previousSource: currentSource,
      newSource: normalizedTargetSource,
      quickbooksConnected: quickbooksStateAfterSwitch.isConnected,
      dbUpdateResult: dbResult,
      durationMs,
    });

    return {
      success: true,
      activeSource: normalizedTargetSource,
      sources: updatedSources,
      quickbooksConnected: quickbooksStateAfterSwitch.isConnected,
    };
  }

  /**
   * Validates if an operation is allowed for the given source.
   */
  async validateOperation(companyId, operationSource) {
    const normalizedOperationSource = normalizeSourceKey(operationSource);
    if (!normalizedOperationSource) {
      throw new Error(`Unknown operation source: ${operationSource}`);
    }

    const state = await this.getDataSourceState(companyId);
    const company = await this.getCompanySourceState(companyId);
    const companySource = normalizeSourceKey(company?.data_source_type);
    const activeSource = companySource || state.activeSource;

    if (!activeSource) {
      if (
        normalizedOperationSource === REPORT_SOURCE_KEYS.MANUAL_GL &&
        state.quickbooksConnected
      ) {
        throw createSourceError(
          "QuickBooks is currently connected. Disconnect QuickBooks to use Manual Upload.",
          "QB_DISCONNECT_REQUIRED",
          { requiresConfirmation: true, nextAction: "disconnect_quickbooks", requestedSource: normalizedOperationSource, currentSource: activeSource },
        );
      }
      return;
    }

    if (activeSource !== normalizedOperationSource) {
      if (normalizedOperationSource === REPORT_SOURCE_KEYS.MANUAL_GL) {
        throw createSourceError(
          "QuickBooks is currently the active source. Switch to Manual Upload first.",
          "QUICKBOOKS_SOURCE_ACTIVE",
          {
            requiresConfirmation: true,
            nextAction: "switch_to_manual",
            requestedSource: normalizedOperationSource,
            currentSource: activeSource,
          },
        );
      }

      throw createSourceError(
        "Manual Upload is currently active. Switch to QuickBooks to perform this action.",
        "MANUAL_SOURCE_ACTIVE",
        { requiresConfirmation: true, nextAction: "switch_to_quickbooks", requestedSource: normalizedOperationSource, currentSource: activeSource },
      );
    }
  }
}

module.exports = new DataSourceService();
