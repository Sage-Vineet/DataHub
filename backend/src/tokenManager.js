const axios = require("axios");
const { getQBConfig, updateTokens } = require("./qbconfig");

// Get access token for a specific client
function getAccessToken(clientId) {
  // If no clientId, getQBConfig will fallback to root config
  const config = getQBConfig(clientId);
  if (!config.accessToken) {
    throw new Error(`No access token available for client ${clientId || "default"}. Please authenticate.`);
  }
  return config.accessToken;
}

// Refresh access token for a specific client
async function refreshAccessToken(clientId) {
  const config = getQBConfig(clientId);

  if (!config.refreshToken) {
    throw new Error(`No refresh token available for client ${clientId}. Please re-authenticate.`);
  }

  try {
    console.log(`🔄 Attempting to refresh token for client: ${clientId}...`);

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
    updateTokens(
      clientId,
      response.data.access_token,
      response.data.refresh_token,
      response.data.expires_in
    );

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
function isTokenExpiring(expiresIn) {
  return false;
}

module.exports = {
  getAccessToken,
  refreshAccessToken,
  isTokenExpiring,
};
