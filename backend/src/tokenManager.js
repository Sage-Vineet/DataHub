const axios = require("axios");
const { getQBConfig, updateTokens } = require("./qbconfig");

// Get access token
function getAccessToken() {
  const config = getQBConfig();
  if (!config.accessToken) {
    throw new Error("No access token available. Please authenticate.");
  }
  return config.accessToken;
}

// Refresh access token
async function refreshAccessToken() {
  const config = getQBConfig();

  if (!config.refreshToken) {
    throw new Error("No refresh token available. Please re-authenticate.");
  }

  try {
    console.log("🔄 Attempting to refresh token...");

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

    // Update global tokens
    updateTokens(
      response.data.access_token,
      response.data.refresh_token,
      response.data.expires_in
    );

    console.log("✅ Token refreshed successfully");
    return response.data.access_token;
  } catch (error) {
    console.error("❌ Token refresh failed:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    throw error;
  }
}

// Check if token is about to expire (if we had expiry info)
function isTokenExpiring(expiresIn) {
  // Implement if you store token expiry time
  return false;
}

module.exports = {
  getAccessToken,
  refreshAccessToken,
  isTokenExpiring,
};
