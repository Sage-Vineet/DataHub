const fs = require("fs");
const path = require("path");

// On Vercel, env vars are injected natively. dotenv is only needed locally.
try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch (_) {
  // dotenv file may not exist in all environments.
}

const IS_VERCEL = process.env.VERCEL === "1";
const STATE_FILE =
  process.env.QB_STATE_FILE ||
  (IS_VERCEL
    ? path.join("/tmp", "qb-state.json")
    : path.join(__dirname, "..", "qb-state.json"));

/**
 * Multi-tenant QuickBooks config store.
 * Structure: { [clientId]: { realmId, accessToken, refreshToken, ... } }
 */
let qbStates = {};

function loadStates() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, "utf8");
      qbStates = JSON.parse(data) || {};
      console.log(
        `Loaded QuickBooks states for ${Object.keys(qbStates).length} companies.`,
      );
    }
  } catch (error) {
    console.warn("Error loading qb-state.json:", error.message);
    qbStates = {};
  }
}

function saveStates() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(qbStates, null, 2));
  } catch (error) {
    console.error("Error saving qb-state.json:", error.message);
  }
}

loadStates();

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

function getQBConfig(clientId) {
  // Reload state on Vercel to handle serverless cold starts and drift.
  if (IS_VERCEL) loadStates();

  // If clientId exists, use scoped config. Otherwise fallback to default root.
  // The fallback also supports legacy single-tenant state files.
  const state = clientId && qbStates[clientId] ? qbStates[clientId] : qbStates;

  if (!clientId && (!state || !state.realmId)) {
    console.warn(
      "getQBConfig called without clientId and no default connection found.",
    );
  }

  return {
    ...DEFAULT_CONFIG,
    ...state,
  };
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

function setQBConfig(clientId, newConfig) {
  if (!clientId) {
    console.error("setQBConfig called without clientId.");
    return;
  }

  qbStates[clientId] = {
    ...(qbStates[clientId] || {}),
    ...newConfig,
  };
  saveStates();
}

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

function disconnectConfig(clientId) {
  if (clientId && qbStates[clientId]) {
    delete qbStates[clientId];
    console.log(`QuickBooks connection cleared for client: ${clientId}`);
  } else {
    // Clear root-level legacy/default connection keys.
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

    console.log("Default QuickBooks connection cleared from root configuration.");
  }

  saveStates();
}

function isConnected(clientId) {
  const config = getQBConfig(clientId);
  return !!(config && config.accessToken && config.realmId);
}

module.exports = {
  getQBConfig,
  validateConfig,
  setQBConfig,
  updateTokens,
  disconnectConfig,
  isConnected,
};
