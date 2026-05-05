const { supabase } = require("../db");
const { logQuickBooksDebug, maskValue } = require("../quickbooksLogger");

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

async function upsertQuickBooksConnection(connection) {
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

  const existingByRealm = await getQuickBooksConnectionByRealmId(realmId);
  if (existingByRealm && existingByRealm.dataHubCompanyId !== companyId) {
    console.error(`[QB Store] ❌ Realm conflict detected! Realm ${realmId} is already linked to company ${existingByRealm.dataHubCompanyId}. Cannot link to ${companyId}.`);
    const realmConflictError = new Error(
      `QuickBooks realm ${realmId} is already linked to another DataHub company.`,
    );
    realmConflictError.code = "QB_REALM_ALREADY_LINKED";
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

  return savedConnection;
}

async function deleteQuickBooksConnection(companyId) {
  if (!companyId) return false;

  const { error } = await supabase
    .from("quickbooks_connections")
    .delete()
    .eq("company_id", companyId);

  if (error) {
    console.error("Error deleting QB connection:", error.message);
    return false;
  }

  logQuickBooksDebug("db_connection_delete", {
    companyId
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

  return true;
}

module.exports = {
  deleteQuickBooksConnection,
  softDisconnectQuickBooks,
  getQuickBooksConnectionByCompanyId,
  getQuickBooksConnectionByRealmId,
  upsertQuickBooksConnection,
};

