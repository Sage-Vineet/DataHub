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
      console.log(`✅ Loaded QuickBooks states for ${Object.keys(qbStates).length} companies.`);
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
const isSandbox = process.env.NODE_ENV !== "production" || process.env.QB_ENVIRONMENT === "sandbox";
const QB_BASE_URL = process.env.QB_BASE_URL || (isSandbox
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
  const state = (clientId && qbStates[clientId]) ? qbStates[clientId] : qbStates;

  if (!clientId && (!state || !state.realmId)) {
    console.warn("⚠️ getQBConfig called without clientId and no default connection found.");
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

  const expiryDate = new Date(Date.now() + (expiresIn || 3600) * 1000).toISOString();

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
    console.log("🛑 Default QuickBooks connection cleared from root configuration.");
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
}

module.exports = {
  getQBConfig,
  setQBConfig,
  updateTokens,
  disconnectConfig,
  isConnected,
};
