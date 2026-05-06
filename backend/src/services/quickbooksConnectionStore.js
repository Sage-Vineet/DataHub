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
    const realmConflictError = new Error(
      `QuickBooks realm ${realmId} is already linked to DataHub company ${existingByRealm.dataHubCompanyId}.`,
    );
    realmConflictError.code = "QB_REALM_ALREADY_LINKED";
    throw realmConflictError;
  }

  const syncedEntitiesData = serializeSyncedEntities(syncedEntities);
  const normalizedConnectedAt = connectedAt || new Date().toISOString();

  const { data, error } = await supabase
    .from("quickbooks_connections")
    .upsert({
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
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id" })
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

module.exports = {
  deleteQuickBooksConnection,
  getQuickBooksConnectionByCompanyId,
  getQuickBooksConnectionByRealmId,
  upsertQuickBooksConnection,
};

