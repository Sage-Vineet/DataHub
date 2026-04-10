const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const {
  getQBConfig,
  updateTokens,
  setQBConfig,
  disconnectConfig,
} = require("../../qbconfig");

const router = express.Router();

/**
 * Extract Client ID from headers
 */
function getClientId(req) {
  let clientId = req.headers["x-client-id"] || req.query.clientId;

  // If still missing, try to extract from state (common in redirects)
  if (!clientId && req.query.state) {
    const rawState = decodeURIComponent(req.query.state);
    // Try JSON format first
    try {
      const parsed = JSON.parse(rawState);
      clientId = parsed.clientId;
    } catch (e) {
      // Try extracting from path string (e.g. /broker/client/UUID/...)
      const match = rawState.match(/\/client\/([^/]+)/);
      if (match) clientId = match[1];
    }
  }

  return clientId;
}

function getAppBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (host) return `${proto}://${host}`;
  return (process.env.CORS_ORIGIN || "http://localhost:3000").replace(
    /\/$/,
    "",
  );
}

function getFrontendBaseUrl(req) {
  if (process.env.FRONTEND_URL)
    return process.env.FRONTEND_URL.replace(/\/$/, "");
  const origin = req.headers.origin;
  if (origin) return origin.replace(/\/$/, "");
  return (process.env.CORS_ORIGIN || "http://localhost:5173").replace(
    /\/$/,
    "",
  );
}

function buildFrontendHashUrl(baseUrl, hashPath, searchParams = "") {
  const normalizedHash = hashPath?.startsWith("/")
    ? hashPath
    : "/broker/companies";
  return `${baseUrl}/#${normalizedHash}${searchParams}`;
}

// ────────────────────────────────────────────────────────────
// GET /refresh-token — Refresh access token for a specific client
// ────────────────────────────────────────────────────────────
router.get("/refresh-token", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    return res.status(400).json({ error: "Missing Client ID" });
  }

  const qb = getQBConfig(clientId);

  if (!qb.refreshToken || !qb.basicToken) {
    return res.status(400).json({
      error: `QuickBooks not connected for client ${clientId}`,
    });
  }

  try {
    const response = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: qb.refreshToken,
      }),
      {
        headers: {
          Authorization: `Basic ${qb.basicToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      },
    );

    updateTokens(
      clientId,
      response.data.access_token,
      response.data.refresh_token,
      response.data.expires_in,
    );

    return res.json({
      success: true,
      message: "Tokens refreshed successfully",
      expiresIn: response.data.expires_in,
      lastSynced: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      `❌ Token refresh failed for client ${clientId}:`,
      error.response?.data || error.message,
    );
    if (error.response)
      return res.status(error.response.status).json(error.response.data);
    return res
      .status(500)
      .json({ error: "Failed to refresh token", details: error.message });
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/auth/quickbooks — Start OAuth flow
// ────────────────────────────────────────────────────────────
router.get("/api/auth/quickbooks", (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    return res
      .status(400)
      .json({ error: "Cannot start OAuth without Client ID" });
  }

  const qb = getQBConfig(clientId);
  const qbClientId = qb.clientId || process.env.QB_CLIENT_ID;
  const appBaseUrl = getAppBaseUrl(req);
  const redirectUri =
    process.env.QB_REDIRECT_URI || `${appBaseUrl}/api/auth/callback`;
  const scope = "com.intuit.quickbooks.accounting";

  // The state carries both the redirect path and our internal clientId
  const state =
    req.query.state ||
    encodeURIComponent(
      JSON.stringify({ redirect: "/broker/companies", clientId }),
    );

  const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${qbClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;

  console.log(`🔗 Redirecting to QuickBooks OAuth for client: ${clientId}...`);
  res.redirect(authUrl);
});

// ────────────────────────────────────────────────────────────
// GET /api/auth/callback — Handle OAuth redirect
// ────────────────────────────────────────────────────────────
router.get("/api/auth/callback", async (req, res) => {
  const { code, realmId, state: rawState } = req.query;
  const appBaseUrl = getAppBaseUrl(req);
  const frontendUrl = getFrontendBaseUrl(req);

  let state = {};
  try {
    state = JSON.parse(decodeURIComponent(rawState));
  } catch (e) {
    state = { redirect: decodeURIComponent(rawState || "/broker/companies") };
  }

  let clientId = state.clientId;

  // If missing from JSON state, try extracting from the redirect path itself
  if (!clientId && state.redirect) {
    const match = state.redirect.match(/\/client\/([^/]+)/);
    if (match) clientId = match[1];
  }

  const redirectHash = state.redirect || "/broker/companies";

  if (!code || !realmId || !clientId) {
    console.error("❌ Callback missing code, realmId, or clientId");
    return res.redirect(
      buildFrontendHashUrl(
        frontendUrl,
        redirectHash,
        "?qbStatus=error&qbMessage=Invalid+callback+data",
      ),
    );
  }

  const qb = getQBConfig(clientId);
  const qbClientId = qb.clientId || process.env.QB_CLIENT_ID;
  const qbClientSecret = qb.clientSecret || process.env.QB_CLIENT_SECRET;
  const basicToken = Buffer.from(`${qbClientId}:${qbClientSecret}`).toString(
    "base64",
  );
  const redirectUri =
    process.env.QB_REDIRECT_URI || `${appBaseUrl}/api/auth/callback`;

  try {
    const tokenResponse = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: redirectUri,
      }),
      {
        headers: {
          Authorization: `Basic ${basicToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      },
    );

    const now = new Date().toISOString();
    const tokenExpiresAt = new Date(
      Date.now() + (tokenResponse.data.expires_in || 3600) * 1000,
    ).toISOString();

    const tokenData = {
      realmId: realmId,
      accessToken: tokenResponse.data.access_token,
      refreshToken: tokenResponse.data.refresh_token,
      basicToken: basicToken,
      companyId: realmId,
      connectedAt: now,
      lastSynced: now,
      tokenExpiresAt: tokenExpiresAt,
      environment: qb.baseUrl?.includes("sandbox") ? "sandbox" : "production",
      syncedEntities: [
        "Customers",
        "Invoices",
        "Balance Sheet",
        "General Ledger",
        "Profit and Loss",
      ],
    };

    setQBConfig(clientId, tokenData);

    // Fetch company info
    try {
      const companyRes = await axios.get(
        `${qb.baseUrl}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`,
        {
          headers: {
            Authorization: `Bearer ${tokenResponse.data.access_token}`,
            Accept: "application/json",
          },
        },
      );

      const info = companyRes.data.CompanyInfo;
      if (info) {
        setQBConfig(clientId, { companyName: info.CompanyName });
        console.log(
          `🏢 Connected to Company: ${info.CompanyName} for Client: ${clientId}`,
        );
      }
    } catch (companyErr) {
      console.warn("⚠️ Could not fetch company info:", companyErr.message);
    }

    console.log(
      `✅ QuickBooks authentication successful for Client: ${clientId}`,
    );
    return res.redirect(
      buildFrontendHashUrl(frontendUrl, redirectHash, "?qbStatus=success"),
    );
  } catch (error) {
    console.error(
      "❌ QuickBooks Callback Error:",
      error.response?.data || error.message,
    );
    return res.redirect(
      buildFrontendHashUrl(
        frontendUrl,
        redirectHash,
        "?qbStatus=error&qbMessage=OAuth+exchange+failed",
      ),
    );
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/auth/status — Scoped connection status
// ────────────────────────────────────────────────────────────
router.get("/api/auth/status", (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    return res.json({
      success: true,
      isConnected: false,
      message: "No Client ID provided",
    });
  }

  const qb = getQBConfig(clientId);
  const isConnected = !!(qb.accessToken && qb.realmId);

  if (!isConnected) {
    return res.json({ success: true, isConnected: false, syncedEntities: [] });
  }

  return res.json({
    success: true,
    isConnected: true,
    companyName: qb.companyName || null,
    companyId: qb.companyId || qb.realmId,
    environment: qb.environment || "production",
    connectedAt: qb.connectedAt || null,
    lastSynced: qb.lastSynced || null,
    tokenExpiresAt: qb.tokenExpiresAt || null,
    syncedEntities: qb.syncedEntities || [],
  });
});

// ────────────────────────────────────────────────────────────
// GET /api/auth/disconnect — Scoped disconnect
// ────────────────────────────────────────────────────────────
router.get("/api/auth/disconnect", (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "Missing Client ID" });

  disconnectConfig(clientId);
  return res.json({ success: true, message: "Disconnected successfully" });
});

module.exports = router;
