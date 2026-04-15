const {
  deleteQuickBooksConnection,
  getQuickBooksConnectionByCompanyId,
  upsertQuickBooksConnection,
} = require("./services/quickbooksConnectionStore");
const { logQuickBooksDebug, maskValue } = require("./quickbooksLogger");

let qbStates = {};

const isSandbox =
  process.env.NODE_ENV !== "production" ||
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

  delete qbStates[clientId];
  await deleteQuickBooksConnection(clientId);
  console.log(`QuickBooks connection cleared for client: ${clientId}`);
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
