const fs = require("fs");
const path = require("path");

// On Vercel, env vars are injected natively — dotenv is only needed locally
try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch (_) {
  // dotenv file may not exist on Vercel; that's fine
}

const IS_VERCEL = process.env.VERCEL === "1";
const STATE_FILE = IS_VERCEL
  ? path.join("/tmp", "qb-state.json")
  : path.join(__dirname, "..", "qb-state.json");

/**
 * Multi-tenant QuickBooks Config Store
 * Structure: { [clientId]: { realmId, accessToken, refreshToken, ... } }
 */
let qbStates = {};

// Load existing states from file on startup
function loadStates() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, "utf8");
      qbStates = JSON.parse(data) || {};
      console.log(
        `✅ Loaded QuickBooks states for ${Object.keys(qbStates).length} companies.`,
      );
    }
  } catch (error) {
    console.warn("⚠️ Error loading qb-state.json:", error.message);
    qbStates = {};
  }
}

// Save current states to file
function saveStates() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(qbStates, null, 2));
  } catch (error) {
    console.error("❌ Error saving qb-state.json:", error.message);
  }
}

// Initial load
loadStates();

/**
 * Get environment-based URLs
 */
const isSandbox =
  process.env.NODE_ENV !== "production" ||
  process.env.QB_ENVIRONMENT === "sandbox";
const QB_BASE_URL =
  process.env.QB_BASE_URL ||
  (isSandbox
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com");

/**
 * Default configuration template
 */
const DEFAULT_CONFIG = {
  clientId: process.env.QB_CLIENT_ID,
  clientSecret: process.env.QB_CLIENT_SECRET,
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
};

/**
 * Get configuration for a specific client
 * @param {string} clientId - The workspace/company ID
 */
function getQBConfig(clientId) {
  // Reload states on Vercel to handle serverless state drift
  if (IS_VERCEL) loadStates();

  // If clientId is provided, use that specific config.
  // Otherwise, fallback to the top-level properties in qbStates (single-tenant legacy)
  const state = clientId && qbStates[clientId] ? qbStates[clientId] : qbStates;

  if (!clientId && (!state || !state.realmId)) {
    console.warn(
      "⚠️ getQBConfig called without clientId and no default connection found.",
    );
  }

  return {
    ...DEFAULT_CONFIG,
    ...state,
  };
}

/**
 * Update configuration for a specific client
 * @param {string} clientId - The workspace/company ID
 * @param {object} newConfig - New values to merge
 */
function setQBConfig(clientId, newConfig) {
  if (!clientId) {
    console.error("❌ setQBConfig called without clientId.");
    return;
  }

  qbStates[clientId] = {
    ...(qbStates[clientId] || {}),
    ...newConfig,
  };
  saveStates();
}

/**
 * Update tokens for a specific client
 * @param {string} clientId - The workspace/company ID
 * @param {string} accessToken
 * @param {string} refreshToken
 * @param {number} expiresIn - seconds
 */
function updateTokens(clientId, accessToken, refreshToken, expiresIn) {
  if (!clientId) return;

  const expiryDate = new Date(
    Date.now() + (expiresIn || 3600) * 1000,
  ).toISOString();

  setQBConfig(clientId, {
    accessToken,
    refreshToken,
    tokenExpiresAt: expiryDate,
    lastSynced: new Date().toISOString(),
  });
}

/**
 * Disconnect a specific client
 * @param {string} clientId - The workspace/company ID
 */
function disconnectConfig(clientId) {
  if (clientId && qbStates[clientId]) {
    delete qbStates[clientId];
    console.log(`🛑 QuickBooks connection cleared for client: ${clientId}`);
  } else {
    // If no clientId or specific config found, clear the root properties (default connection)
    const keysToClear = [
      "accessToken",
      "refreshToken",
      "realmId",
      "companyName",
      "companyId",
      "tokenExpiresAt",
      "lastSynced",
      "connectedAt",
      "environment",
      "syncedEntities",
    ];
    keysToClear.forEach((key) => {
      delete qbStates[key];
    });
    console.log(
      "🛑 Default QuickBooks connection cleared from root configuration.",
    );
  }
  saveStates();
}

/**
 * Helper to check if a client is connected
 */
function isConnected(clientId) {
  if (!clientId) return false;
  const config = qbStates[clientId];
  return !!(config && config.accessToken && config.realmId);
  const stateFile =
    process.env.QB_STATE_FILE ||
    path.join(
      process.env.VERCEL ? "/tmp" : path.join(__dirname, ".."),
      "qb-state.json",
    );

  function loadState() {
    try {
      if (fs.existsSync(stateFile)) {
        const data = fs.readFileSync(stateFile, "utf8");
        return JSON.parse(data);
      }
    } catch (error) {
      console.error("Error loading qb-state.json:", error);
    }
    return {};
  }

  function saveState(state) {
    try {
      const stateToSave = {
        realmId: state.realmId,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        basicToken: state.basicToken,
        companyName: state.companyName,
        companyId: state.companyId,
        environment: state.environment,
        connectedAt: state.connectedAt,
        lastSynced: state.lastSynced,
        tokenExpiresAt: state.tokenExpiresAt,
        syncedEntities: state.syncedEntities,
        disconnected: state.disconnected || false,
      };
      fs.writeFileSync(stateFile, JSON.stringify(stateToSave, null, 2));
    } catch (error) {
      console.error("Error saving qb-state.json:", error);
    }
  }

  // Build config by merging env vars with any persisted state
  function buildConfig() {
    const savedState = loadState();
    const disconnected = !!savedState.disconnected;

    return {
      realmId: disconnected
        ? null
        : savedState.realmId || process.env.QB_REALM_ID,
      accessToken: disconnected
        ? null
        : savedState.accessToken || process.env.QB_ACCESS_TOKEN,
      refreshToken: disconnected
        ? null
        : savedState.refreshToken || process.env.QB_REFRESH_TOKEN,
      basicToken: disconnected
        ? null
        : savedState.basicToken || process.env.QB_BASIC_TOKEN,
      baseUrl: process.env.QB_BASE_URL || "https://quickbooks.api.intuit.com",
      clientId: process.env.QB_CLIENT_ID,
      clientSecret: process.env.QB_CLIENT_SECRET,
      companyName: savedState.companyName || null,
      companyId: savedState.companyId || null,
      environment:
        savedState.environment ||
        (process.env.QB_BASE_URL?.includes("sandbox")
          ? "sandbox"
          : "production"),
      connectedAt: savedState.connectedAt || null,
      lastSynced: savedState.lastSynced || null,
      tokenExpiresAt: savedState.tokenExpiresAt || null,
      syncedEntities: savedState.syncedEntities || [],
      disconnected,
    };
  }

  // In-memory cache — refreshed from disk on every getQBConfig() call
  let qbConfig = buildConfig();

  function validateConfig() {
    const cfg = getQBConfig();
    const required = ["realmId", "accessToken", "refreshToken", "basicToken"];
    const missing = required.filter((key) => !cfg[key]);

    if (missing.length > 0) {
      console.warn(`⚠️ Missing QuickBooks config: ${missing.join(", ")}`);
      return false;
    }
    return true;
  }

  function getQBConfig() {
    // On Vercel, always re-read from /tmp in case another invocation wrote fresh tokens
    if (process.env.VERCEL) {
      qbConfig = buildConfig();
    }
    return qbConfig;
  }

  function updateTokens(newAccessToken, newRefreshToken, expiresIn) {
    qbConfig.accessToken = newAccessToken;
    qbConfig.refreshToken = newRefreshToken || qbConfig.refreshToken;
    qbConfig.lastSynced = new Date().toISOString();
    qbConfig.disconnected = false;
    if (expiresIn) {
      qbConfig.tokenExpiresAt = new Date(
        Date.now() + expiresIn * 1000,
      ).toISOString();
    }
    saveState(qbConfig);
    console.log("✅ Tokens updated successfully");
  }

  function setQBConfig(config) {
    qbConfig = { ...qbConfig, ...config, disconnected: false };
    saveState(qbConfig);
    console.log("✅ QuickBooks config updated");
    console.log(`   Realm ID: ${qbConfig.realmId}`);
    console.log(`   Base URL: ${qbConfig.baseUrl}`);
    console.log(`   Company: ${qbConfig.companyName || "Unknown"}`);
  }

  function disconnectConfig() {
    qbConfig.accessToken = null;
    qbConfig.refreshToken = null;
    qbConfig.realmId = null;
    qbConfig.basicToken = null;
    qbConfig.companyName = null;
    qbConfig.companyId = null;
    qbConfig.connectedAt = null;
    qbConfig.lastSynced = null;
    qbConfig.tokenExpiresAt = null;
    qbConfig.syncedEntities = [];
    qbConfig.disconnected = true;
    saveState(qbConfig);
    console.log("🛑 QuickBooks connection fully cleared");
  }

  function resetConfig() {
    qbConfig = {
      realmId: process.env.QB_REALM_ID,
      accessToken: process.env.QB_ACCESS_TOKEN,
      refreshToken: process.env.QB_REFRESH_TOKEN,
      basicToken: process.env.QB_BASIC_TOKEN,
      baseUrl: process.env.QB_BASE_URL || "https://quickbooks.api.intuit.com",
      clientId: process.env.QB_CLIENT_ID,
      clientSecret: process.env.QB_CLIENT_SECRET,
      companyName: null,
      companyId: null,
      environment: process.env.QB_BASE_URL?.includes("sandbox")
        ? "sandbox"
        : "production",
      connectedAt: null,
      lastSynced: null,
      tokenExpiresAt: null,
      syncedEntities: [],
      disconnected: false,
    };
    saveState(qbConfig);
  }

  module.exports = {
    getQBConfig,
    setQBConfig,
    updateTokens,
    disconnectConfig,
    isConnected,
  };
}
