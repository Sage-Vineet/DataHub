const path = require("path");
const fs = require("fs");

// On Vercel, env vars are injected natively — dotenv is only needed locally
try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch (_) {
  // dotenv file may not exist on Vercel; that's fine
}

const stateFile =
  process.env.QB_STATE_FILE ||
  path.join(process.env.VERCEL ? "/tmp" : path.join(__dirname, ".."), "qb-state.json");

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
    realmId: disconnected ? null : (savedState.realmId || process.env.QB_REALM_ID),
    accessToken: disconnected ? null : (savedState.accessToken || process.env.QB_ACCESS_TOKEN),
    refreshToken: disconnected ? null : (savedState.refreshToken || process.env.QB_REFRESH_TOKEN),
    basicToken: disconnected ? null : (savedState.basicToken || process.env.QB_BASIC_TOKEN),
    baseUrl: process.env.QB_BASE_URL || "https://quickbooks.api.intuit.com",
    clientId: process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    companyName: savedState.companyName || null,
    companyId: savedState.companyId || null,
    environment: savedState.environment || (process.env.QB_BASE_URL?.includes("sandbox") ? "sandbox" : "production"),
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
    qbConfig.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
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
    environment: process.env.QB_BASE_URL?.includes("sandbox") ? "sandbox" : "production",
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
  updateTokens,
  setQBConfig,
  disconnectConfig,
  resetConfig,
  validateConfig,
};

validateConfig();
