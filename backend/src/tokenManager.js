const axios = require("axios");
const { getQBConfig, loadQBConfig, updateTokens } = require("./qbconfig");
const { logQuickBooksDebug, maskValue } = require("./quickbooksLogger");

// Get access token for a specific client
function getAccessToken(clientId) {
  if (!clientId) {
    throw new Error("Client ID is required to resolve a QuickBooks access token.");
  }

  const config = getQBConfig(clientId);
  if (!config.accessToken) {
    throw new Error(
      `No access token available for client ${clientId}. Please authenticate.`,
    );
  }
  return config.accessToken;
}

// Refresh access token for a specific client
async function refreshAccessToken(clientId) {
  if (!clientId) {
    throw new Error(
      "Client ID is required to refresh a QuickBooks access token.",
    );
  }

  await loadQBConfig(clientId);
  const config = getQBConfig(clientId);

  // Guard: do NOT attempt refresh if connection is disconnected
  if (!config.realmId) {
    console.log(`[QB Token] Skipping refresh — no active connection for client: ${clientId}`);
    throw new Error(
      `QuickBooks is disconnected for client ${clientId}. Cannot refresh tokens.`,
    );
  }

  if (!config.refreshToken) {
    throw new Error(
      `No refresh token available for client ${clientId}. Please re-authenticate.`,
    );
  }

  try {
    console.log(`🔄 Attempting to refresh token for client: ${clientId}...`);
    logQuickBooksDebug("token_refresh_started", {
      clientId,
      realmId: config.realmId || null,
      oauthClientId: config.oauthClientId
        ? maskValue(config.oauthClientId)
        : null,
    });

    const response = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.refreshToken,
      }),
      {
        headers: {
          Authorization: `Basic ${config.basicToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        timeout: 10000, // 10 second timeout
      },
    );

    if (!response.data || !response.data.access_token) {
      throw new Error("Invalid response from token refresh endpoint");
    }

    // Update tokens for THIS specific client
    await updateTokens(
      clientId,
      response.data.access_token,
      response.data.refresh_token,
      response.data.expires_in,
    );

    logQuickBooksDebug("token_refresh_completed", {
      clientId,
      realmId: config.realmId || null,
      accessToken: maskValue(response.data.access_token),
      refreshToken: maskValue(response.data.refresh_token),
      expiresIn: response.data.expires_in,
    });

    console.log(`✅ Token refreshed successfully for client: ${clientId}`);
    return response.data.access_token;
  } catch (error) {
    console.error(`❌ Token refresh failed for client: ${clientId}:`, {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    throw error;
  }
}

// Check if token is about to expire
function isTokenExpiring(tokenExpiresAt) {
  if (!tokenExpiresAt) return true; // Assume expired if no date
  
  const expiry = new Date(tokenExpiresAt);
  const now = new Date();
  
  // Refresh if expired or expiring in the next 5 minutes
  const bufferTime = 5 * 60 * 1000;
  return expiry.getTime() - now.getTime() < bufferTime;
}

module.exports = {
  getAccessToken,
  refreshAccessToken,
  isTokenExpiring,
};
