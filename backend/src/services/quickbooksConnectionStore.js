const db = require("../db");
const { logQuickBooksDebug, maskValue } = require("../quickbooksLogger");

let ensureTablePromise = null;

function parseSyncedEntities(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function serializeSyncedEntities(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
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

async function ensureConnectionTable() {
  if (ensureTablePromise) {
    return ensureTablePromise;
  }

  ensureTablePromise = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS quickbooks_connections (
        company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
        realm_id text NOT NULL UNIQUE,
        company_name text,
        access_token text NOT NULL,
        refresh_token text NOT NULL,
        token_expires_at timestamptz,
        connected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_synced timestamptz,
        environment text NOT NULL DEFAULT 'sandbox',
        oauth_client_id text NOT NULL,
        redirect_uri text NOT NULL,
        synced_entities text NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_quickbooks_connections_realm_id
      ON quickbooks_connections(realm_id)
    `);

    logQuickBooksDebug("db_connection_table_ready", {
      engine: db.engine,
    });
  })().catch((error) => {
    ensureTablePromise = null;
    throw error;
  });

  return ensureTablePromise;
}

async function getQuickBooksConnectionByCompanyId(companyId) {
  if (!companyId) return null;

  await ensureConnectionTable();

  const result = await db.query(
    `
      SELECT
        company_id,
        realm_id,
        company_name,
        access_token,
        refresh_token,
        token_expires_at,
        connected_at,
        last_synced,
        environment,
        oauth_client_id,
        redirect_uri,
        synced_entities,
        created_at,
        updated_at
      FROM quickbooks_connections
      WHERE company_id = ?
    `,
    [companyId],
  );

  const connection = mapRowToConnection(result?.rows?.[0]);

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

  await ensureConnectionTable();

  const result = await db.query(
    `
      SELECT
        company_id,
        realm_id,
        company_name,
        access_token,
        refresh_token,
        token_expires_at,
        connected_at,
        last_synced,
        environment,
        oauth_client_id,
        redirect_uri,
        synced_entities,
        created_at,
        updated_at
      FROM quickbooks_connections
      WHERE realm_id = ?
    `,
    [realmId],
  );

  return mapRowToConnection(result?.rows?.[0]);
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

  await ensureConnectionTable();

  const existingByRealm = await getQuickBooksConnectionByRealmId(realmId);
  if (existingByRealm && existingByRealm.dataHubCompanyId !== companyId) {
    const realmConflictError = new Error(
      `QuickBooks realm ${realmId} is already linked to DataHub company ${existingByRealm.dataHubCompanyId}.`,
    );
    realmConflictError.code = "QB_REALM_ALREADY_LINKED";
    throw realmConflictError;
  }

  const existingByCompany = await getQuickBooksConnectionByCompanyId(companyId);
  const syncedEntitiesJson = serializeSyncedEntities(syncedEntities);
  const normalizedConnectedAt = connectedAt || new Date().toISOString();
  const action = existingByCompany ? "update" : "insert";

  if (existingByCompany) {
    await db.query(
      `
        UPDATE quickbooks_connections
        SET
          realm_id = ?,
          company_name = ?,
          access_token = ?,
          refresh_token = ?,
          token_expires_at = ?,
          connected_at = ?,
          last_synced = ?,
          environment = ?,
          oauth_client_id = ?,
          redirect_uri = ?,
          synced_entities = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE company_id = ?
      `,
      [
        realmId,
        companyName || null,
        accessToken,
        refreshToken,
        tokenExpiresAt || null,
        normalizedConnectedAt,
        lastSynced || null,
        environment || "sandbox",
        oauthClientId,
        redirectUri,
        syncedEntitiesJson,
        companyId,
      ],
    );
  } else {
    await db.query(
      `
        INSERT INTO quickbooks_connections (
          company_id,
          realm_id,
          company_name,
          access_token,
          refresh_token,
          token_expires_at,
          connected_at,
          last_synced,
          environment,
          oauth_client_id,
          redirect_uri,
          synced_entities,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
      [
        companyId,
        realmId,
        companyName || null,
        accessToken,
        refreshToken,
        tokenExpiresAt || null,
        normalizedConnectedAt,
        lastSynced || null,
        environment || "sandbox",
        oauthClientId,
        redirectUri,
        syncedEntitiesJson,
      ],
    );
  }

  const savedConnection = await getQuickBooksConnectionByCompanyId(companyId);

  logQuickBooksDebug("db_connection_upsert", {
    action,
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

  await ensureConnectionTable();

  const existing = await getQuickBooksConnectionByCompanyId(companyId);

  await db.query("DELETE FROM quickbooks_connections WHERE company_id = ?", [
    companyId,
  ]);

  logQuickBooksDebug("db_connection_delete", {
    companyId,
    realmId: existing?.realmId || null,
  });

  return Boolean(existing);
}

module.exports = {
  deleteQuickBooksConnection,
  ensureConnectionTable,
  getQuickBooksConnectionByCompanyId,
  getQuickBooksConnectionByRealmId,
  upsertQuickBooksConnection,
};
