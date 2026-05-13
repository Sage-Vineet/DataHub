const {
  softDisconnectQuickBooks,
  getQuickBooksConnectionByCompanyId,
  upsertQuickBooksConnection,
  deleteQuickBooksConnection,
} = require("./services/quickbooksConnectionStore");
const { logQuickBooksDebug, maskValue } = require("./quickbooksLogger");

let qbStates = {};

const isSandbox =
  process.env.QB_ENVIRONMENT !== "production" ||
  process.env.QB_ENVIRONMENT === "sandbox";
const QB_BASE_URL =
  process.env.QB_BASE_URL ||
  (isSandbox
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com");

const DEFAULT_CONFIG = {
  clientId: process.env.QB_CLIENT_ID,
  clientSecret: process.env.QB_CLIENT_SECRET,
  oauthClientId: null,
  redirectUri: process.env.QB_REDIRECT_URI || null,
  baseUrl: QB_BASE_URL,
  realmId: null,
  accessToken: null,
  refreshToken: null,
  basicToken: null,
  companyName: null,
  companyId: null,
  tokenExpiresAt: null,
  lastSynced: null,
  connectedAt: null,
  syncedEntities: [],
  environment: isSandbox ? "sandbox" : "production",
  hasCredentialMismatch: false,
};

function buildBasicToken(clientId, clientSecret) {
  if (!clientId || !clientSecret) return null;
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function mergeWithDefault(state = {}) {
  const oauthClientId = state.oauthClientId || state.clientId || null;
  const hasCredentialMismatch = Boolean(
    oauthClientId &&
      DEFAULT_CONFIG.clientId &&
      oauthClientId !== DEFAULT_CONFIG.clientId,
  );

  return {
    ...DEFAULT_CONFIG,
    ...(state || {}),
    oauthClientId,
    dataHubCompanyId: state?.dataHubCompanyId || null,
    companyId: state?.companyId || state?.realmId || null,
    basicToken:
      state?.basicToken ||
      buildBasicToken(DEFAULT_CONFIG.clientId, DEFAULT_CONFIG.clientSecret),
    hasCredentialMismatch,
  };
}

function getQBConfig(clientId) {
  if (!clientId) {
    return mergeWithDefault();
  }

  return mergeWithDefault(qbStates[clientId]);
}

async function loadQBConfig(clientId) {
  if (!clientId) {
    return mergeWithDefault();
  }

  const connection = await getQuickBooksConnectionByCompanyId(clientId);

  if (!connection) {
    delete qbStates[clientId];
    return mergeWithDefault();
  }

  // If the connection was soft-disconnected, treat it as non-existent
  // so the status endpoint correctly reports isConnected = false.
  if (connection.isConnected === false) {
    console.log(`[QB Config] DB says is_connected=false for client=${clientId} — treating as disconnected`);
    delete qbStates[clientId];
    return mergeWithDefault();
  }

  qbStates[clientId] = {
    ...(qbStates[clientId] || {}),
    ...connection,
  };

  const config = getQBConfig(clientId);

  if (config.hasCredentialMismatch) {
    logQuickBooksDebug("credential_mismatch_detected", {
      clientId,
      storedOAuthClientId: maskValue(config.oauthClientId),
      configuredClientId: maskValue(config.clientId),
    });
  }

  return config;
}

function validateConfig(clientId) {
  const cfg = getQBConfig(clientId);
  const required = ["realmId", "accessToken", "refreshToken", "basicToken"];
  const missing = required.filter((key) => !cfg[key]);

  if (missing.length > 0) {
    console.warn(`Missing QuickBooks config: ${missing.join(", ")}`);
    return false;
  }

  return true;
}

async function setQBConfig(clientId, newConfig) {
  if (!clientId) {
    throw new Error("setQBConfig called without clientId.");
  }

  const currentState = qbStates[clientId] || (await loadQBConfig(clientId));
  const nextState = {
    ...currentState,
    ...newConfig,
  };

  const persistedState = await upsertQuickBooksConnection({
    companyId: clientId,
    userId: nextState.userId || null,
    realmId: nextState.realmId,
    companyName: nextState.companyName || null,
    accessToken: nextState.accessToken,
    refreshToken: nextState.refreshToken,
    tokenExpiresAt: nextState.tokenExpiresAt || null,
    connectedAt: nextState.connectedAt || new Date().toISOString(),
    lastSynced: nextState.lastSynced || null,
    environment: nextState.environment || DEFAULT_CONFIG.environment,
    syncedEntities: nextState.syncedEntities || [],
    oauthClientId:
      nextState.oauthClientId || nextState.clientId || DEFAULT_CONFIG.clientId,
    redirectUri: nextState.redirectUri || DEFAULT_CONFIG.redirectUri,
  });

  qbStates[clientId] = {
    ...nextState,
    ...persistedState,
  };

  return getQBConfig(clientId);
}

async function updateTokens(clientId, accessToken, refreshToken, expiresIn) {
  if (!clientId) {
    throw new Error("updateTokens called without clientId.");
  }

  const currentState = qbStates[clientId] || (await loadQBConfig(clientId));
  if (!currentState.realmId) {
    throw new Error(
      `Cannot update QuickBooks tokens without an existing realm mapping for client ${clientId}.`,
    );
  }

  const expiryDate = new Date(
    Date.now() + (expiresIn || 3600) * 1000,
  ).toISOString();

  return setQBConfig(clientId, {
    accessToken,
    refreshToken: refreshToken || currentState.refreshToken,
    tokenExpiresAt: expiryDate,
    lastSynced: new Date().toISOString(),
  });
}

async function disconnectConfig(clientId) {
  if (!clientId) {
    throw new Error("disconnectConfig called without clientId.");
  }

  // Attempt to revoke the token from Intuit
  const currentState = qbStates[clientId] || (await loadQBConfig(clientId));
  if (currentState && (currentState.refreshToken || currentState.accessToken)) {
    try {
      const basicToken = currentState.basicToken || buildBasicToken(currentState.clientId || DEFAULT_CONFIG.clientId, currentState.clientSecret || DEFAULT_CONFIG.clientSecret);
      const tokenToRevoke = currentState.refreshToken || currentState.accessToken;
      const axios = require("axios");
      
      if (tokenToRevoke) {
        await axios.post(
          "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
          new URLSearchParams({ token: tokenToRevoke }),
          {
            headers: {
              Authorization: `Basic ${basicToken}`,
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
            },
          }
        );
        console.log(`[QB Disconnect] Intuit token revoked for client: ${clientId}`);
      }
    } catch (revokeErr) {
      console.warn(`[QB Disconnect] Intuit token revocation failed (may be expired):`, revokeErr.response?.data || revokeErr.message);
    }
  }

  // 1. Clear in-memory state FIRST
  delete qbStates[clientId];
  console.log(`[QB Disconnect] In-memory state cleared for client: ${clientId}`);

  // 2. Persist to DB: HARD DELETE connection instead of soft disconnect
  const success = await deleteQuickBooksConnection(clientId);
  if (!success) {
    console.error(`[QB Disconnect] ❌ DB delete FAILED for client: ${clientId}`);
    throw new Error("Failed to delete QuickBooks connection from database.");
  }

  console.log(`[QB Disconnect] ✅ Complete for client: ${clientId} — memory cleared, DB connection deleted`);
}

function isConnected(clientId) {
  const config = getQBConfig(clientId);
  return !!(config && config.accessToken && config.realmId);
}

module.exports = {
  getQBConfig,
  loadQBConfig,
  validateConfig,
  setQBConfig,
  updateTokens,
  disconnectConfig,
  isConnected,
};
