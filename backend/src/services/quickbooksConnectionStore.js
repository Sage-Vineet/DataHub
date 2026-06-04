const { supabase } = require("../db");
const { logQuickBooksDebug, maskValue } = require("../quickbooksLogger");
const {
  REPORT_SOURCE_KEYS,
  updateReportSourceRecord,
} = require("./reportSourceStore");

async function markCompanyQuickBooksDisconnected(companyId, now = new Date().toISOString()) {
  if (!companyId) return;

  const { error } = await supabase
    .from("companies")
    .update({
      quickbooks_connected: false,
      updated_at: now,
    })
    .eq("id", companyId);

  if (error) {
    console.warn(
      "[QB Store] Failed to update company quickbooks_connected=false on disconnect:",
      error.message,
    );
  }
}

async function upsertConnectionStatus(companyId, patch = {}) {
  if (!companyId) return;

  const payload = {
    company_id: companyId,
    source: "quickbooks",
    is_connected: patch.isConnected === true,
    disconnected_at: patch.disconnectedAt || null,
    disconnected_reason: patch.disconnectedReason || null,
    last_checked_at: new Date().toISOString(),
    metadata: patch.metadata && typeof patch.metadata === "object" ? patch.metadata : {},
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("connection_status")
    .upsert(payload, { onConflict: "company_id,source" });

  if (error) {
    console.warn("[QB Store] Failed to upsert connection_status:", error.message);
  }
}

function parseSyncedEntities(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function serializeSyncedEntities(value) {
  return Array.isArray(value) ? value : [];
}

function mapRowToConnection(row) {
  if (!row) return null;

  return {
    dataHubCompanyId: row.company_id,
    realmId: row.realm_id,
    companyId: row.realm_id,
    companyName: row.company_name,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
    connectedAt: row.connected_at,
    lastSynced: row.last_synced,
    environment: row.environment,
    oauthClientId: row.oauth_client_id,
    redirectUri: row.redirect_uri,
    syncedEntities: parseSyncedEntities(row.synced_entities),
    isConnected: row.is_connected !== false, // defaults true for backward compat
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getQuickBooksConnectionByCompanyId(companyId) {
  if (!companyId) return null;

  const { data, error } = await supabase
    .from("quickbooks_connections")
    .select("*")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    console.error("Error loading QB connection:", error.message);
    return null;
  }

  const connection = mapRowToConnection(data);

  logQuickBooksDebug("db_connection_load", {
    companyId,
    found: Boolean(connection),
    realmId: connection?.realmId || null,
    oauthClientId: connection?.oauthClientId
      ? maskValue(connection.oauthClientId)
      : null,
  });

  return connection;
}

async function getQuickBooksConnectionByRealmId(realmId) {
  if (!realmId) return null;

  const { data, error } = await supabase
    .from("quickbooks_connections")
    .select("*")
    .eq("realm_id", realmId)
    .maybeSingle();

  if (error) {
    console.error("Error loading QB connection by realm:", error.message);
    return null;
  }

  return mapRowToConnection(data);
}

async function upsertQuickBooksConnection(connection, { skipRealmConflictCheck = false } = {}) {
  const {
    companyId,
    userId,
    realmId,
    companyName,
    accessToken,
    refreshToken,
    tokenExpiresAt,
    connectedAt,
    lastSynced,
    environment,
    oauthClientId,
    redirectUri,
    syncedEntities,
  } = connection || {};

  if (!companyId) {
    throw new Error("QuickBooks connection save failed: missing companyId.");
  }

  if (
    !realmId ||
    !accessToken ||
    !refreshToken ||
    !oauthClientId ||
    !redirectUri
  ) {
    throw new Error(
      "QuickBooks connection save failed: missing realmId, tokens, oauthClientId, or redirectUri.",
    );
  }

  const existingByRealm = skipRealmConflictCheck ? null : await getQuickBooksConnectionByRealmId(realmId);
  if (existingByRealm && existingByRealm.dataHubCompanyId !== companyId) {
    console.error(`[QB Store] ❌ Realm conflict detected! Realm ${realmId} is already linked to company ${existingByRealm.dataHubCompanyId}. Cannot link to ${companyId}.`);
    const realmConflictError = new Error(
      `QuickBooks realm ${realmId} is already linked to another DataHub company.`,
    );
    realmConflictError.code = "QB_REALM_ALREADY_LINKED";
    realmConflictError.conflictingCompanyId = existingByRealm.dataHubCompanyId;
    throw realmConflictError;
  }

  if (existingByRealm) {
    console.log(`[QB Store] Re-linking existing realm ${realmId} to company ${companyId}`);
  }

  const syncedEntitiesData = serializeSyncedEntities(syncedEntities);
  const normalizedConnectedAt = connectedAt || new Date().toISOString();

  const payload = {
    company_id: companyId,
    realm_id: realmId,
    company_name: companyName || null,
    access_token: accessToken,
    refresh_token: refreshToken,
    token_expires_at: tokenExpiresAt || null,
    connected_at: normalizedConnectedAt,
    last_synced: lastSynced || null,
    environment: environment || "sandbox",
    oauth_client_id: oauthClientId,
    redirect_uri: redirectUri,
    synced_entities: syncedEntitiesData,
    is_connected: true,
    updated_at: new Date().toISOString()
  };

  if (userId) {
    payload.user_id = userId;
  }

  console.log("DEBUG UPSERT - user_id:", userId, "company_id:", companyId, "payload:", payload);

  const { data, error } = await supabase
    .from("quickbooks_connections")
    .upsert(payload, { onConflict: "company_id" })
    .select("*")
    .single();

  if (error) {
    throw new Error(`QuickBooks connection save failed: ${error.message}`);
  }

  const savedConnection = mapRowToConnection(data);

  logQuickBooksDebug("db_connection_upsert", {
    companyId,
    realmId,
    companyName: savedConnection?.companyName || null,
    environment: savedConnection?.environment || null,
    oauthClientId: savedConnection?.oauthClientId
      ? maskValue(savedConnection.oauthClientId)
      : null,
  });

  try {
    await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.QUICKBOOKS, {
      isAvailable: true,
      isConnected: true,
      lastConnectedAt: normalizedConnectedAt,
      lastSyncedAt: lastSynced || new Date().toISOString(),
      metadata: {
        realmId,
        companyName: savedConnection?.companyName || companyName || null,
        environment: savedConnection?.environment || environment || null,
      },
    });
  } catch (syncError) {
    console.warn("[QB Store] Failed to refresh report source on upsert:", syncError.message);
  }

  try {
    await supabase
      .from("companies")
      .update({ quickbooks_connected: true, updated_at: new Date().toISOString() })
      .eq("id", companyId);
  } catch (companyStateError) {
    console.warn("[QB Store] Failed to update company quickbooks_connected=true:", companyStateError.message);
  }

  await upsertConnectionStatus(companyId, {
    isConnected: true,
    disconnectedAt: null,
    disconnectedReason: null,
    metadata: {
      realmId,
      environment: savedConnection?.environment || environment || null,
      connectedAt: normalizedConnectedAt,
    },
  });

  return savedConnection;
}

async function deleteQuickBooksConnection(companyId, { disconnectedReason = "deleted", metadata = {} } = {}) {
  if (!companyId) return false;
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("quickbooks_connections")
    .delete()
    .eq("company_id", companyId);

  if (error) {
    console.error("Error deleting QB connection:", error.message);
    return false;
  }

  logQuickBooksDebug("db_connection_delete", {
    companyId,
    disconnectedReason,
  });

  try {
    await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.QUICKBOOKS, {
      isConnected: false,
      metadata: {
        disconnectedAt: now,
      },
    });
  } catch (error) {
    console.warn("[QB Store] Failed to refresh report source on delete:", error.message);
  }

  await markCompanyQuickBooksDisconnected(companyId, now);
  await upsertConnectionStatus(companyId, {
    isConnected: false,
    disconnectedAt: now,
    disconnectedReason,
    metadata: { ...metadata, disconnectedAt: now },
  });

  return true;
}

/**
 * Soft-disconnect: sets is_connected = false and nulls ALL auth fields.
 * The DB row is kept so cached reports remain accessible for offline fallback.
 * realm_id is preserved for potential reconnect identification.
 */
async function softDisconnectQuickBooks(companyId) {
  if (!companyId) return false;

  const now = new Date().toISOString();

  const { error } = await supabase
    .from("quickbooks_connections")
    .update({
      is_connected: false,
      access_token: "",
      refresh_token: "",
      updated_at: now,
    })
    .eq("company_id", companyId);

  if (error) {
    console.error("[QB Disconnect] DB update failed:", error.message);
    return false;
  }

  console.log(`[QB Disconnect] ✅ DB updated: is_connected=false, tokens cleared for company=${companyId}`);
  logQuickBooksDebug("db_connection_soft_disconnect", {
    companyId,
    disconnectedAt: now,
    tokensCleared: true,
  });

  try {
    await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.QUICKBOOKS, {
      isConnected: false,
      metadata: {
        disconnectedAt: now,
      },
    });
  } catch (syncError) {
    console.warn("[QB Store] Failed to refresh report source on soft disconnect:", syncError.message);
  }

  await markCompanyQuickBooksDisconnected(companyId, now);
  await upsertConnectionStatus(companyId, {
    isConnected: false,
    disconnectedAt: now,
    disconnectedReason: "manual_disconnect",
    metadata: { tokensCleared: true },
  });

  return true;
}

/**
 * Atomically transfers a QB realm connection from one DataHub company to another.
 * The old company's row is hard-deleted (freeing the realm_id UNIQUE slot) and a
 * fresh row is inserted for the new company using the newly-issued OAuth tokens.
 * connection_status for both companies is updated for audit purposes.
 */
async function transferQuickBooksConnectionToNewCompany(fromCompanyId, toCompanyId, newConnectionData, options = {}) {
  const { realmId, performedBy } = options;
  const now = new Date().toISOString();

  console.log(`[QB Transfer] Transferring realm ${realmId || newConnectionData.realmId} from company ${fromCompanyId} → ${toCompanyId}`);

  // 1. Archive the outgoing company in connection_status before the hard delete
  //    so the audit reason is preserved (deleteQuickBooksConnection would overwrite it).
  await upsertConnectionStatus(fromCompanyId, {
    isConnected: false,
    disconnectedAt: now,
    disconnectedReason: "transferred",
    metadata: {
      transferredToCompanyId: toCompanyId,
      realmId: realmId || newConnectionData.realmId,
      transferredAt: now,
      performedBy: performedBy || null,
    },
  });

  // 2. Hard-delete the old company's QB row so the realm_id UNIQUE constraint is freed.
  //    We pass a custom reason so the status table update from deleteQuickBooksConnection
  //    matches what we just wrote above.
  const deleted = await deleteQuickBooksConnection(fromCompanyId, {
    disconnectedReason: "transferred",
    metadata: {
      transferredToCompanyId: toCompanyId,
      realmId: realmId || newConnectionData.realmId,
      transferredAt: now,
      performedBy: performedBy || null,
    },
  });

  if (!deleted) {
    throw new Error(`[QB Transfer] Failed to remove old QB connection for company ${fromCompanyId}.`);
  }

  // 3. Insert the new connection for the target company.
  //    skipRealmConflictCheck is safe here because we just deleted the conflicting row.
  const savedConnection = await upsertQuickBooksConnection(
    { ...newConnectionData, companyId: toCompanyId, connectedAt: now },
    { skipRealmConflictCheck: true },
  );

  // 4. Stamp the new company's connection_status with transfer provenance.
  await upsertConnectionStatus(toCompanyId, {
    isConnected: true,
    disconnectedAt: null,
    disconnectedReason: null,
    metadata: {
      realmId: newConnectionData.realmId,
      environment: newConnectionData.environment || null,
      connectedAt: now,
      transferredFromCompanyId: fromCompanyId,
      transferredAt: now,
      performedBy: performedBy || null,
    },
  });

  console.log(`[QB Transfer] ✅ Transfer complete: realm ${newConnectionData.realmId} → company ${toCompanyId}`);
  return savedConnection;
}

module.exports = {
  deleteQuickBooksConnection,
  softDisconnectQuickBooks,
  getQuickBooksConnectionByCompanyId,
  getQuickBooksConnectionByRealmId,
  upsertQuickBooksConnection,
  transferQuickBooksConnectionToNewCompany,
};

