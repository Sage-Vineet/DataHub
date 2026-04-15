const express = require("express");
const axios = require("axios");
const db = require("../../db");
const {
  getQBConfig,
  loadQBConfig,
  updateTokens,
  setQBConfig,
  disconnectConfig,
} = require("../../qbconfig");
const { logQuickBooksDebug, maskValue } = require("../../quickbooksLogger");

const router = express.Router();

function parseOAuthState(rawState) {
  if (!rawState) return {};

  const candidates = [String(rawState)];

  try {
    const decoded = decodeURIComponent(String(rawState));
    if (!candidates.includes(decoded)) {
      candidates.unshift(decoded);
    }
  } catch (_) {
    // Ignore malformed values and fall back to the raw state.
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // Keep trying.
    }
  }

  return { redirect: String(rawState) };
}

function buildOAuthState(redirectHash, clientId) {
  return encodeURIComponent(
    JSON.stringify({
      redirect: redirectHash || "/broker/companies",
      clientId,
    }),
  );
}

/**
 * Extract Client ID from headers
 */
function getClientId(req) {
  let clientId = req.headers["x-client-id"] || req.query.clientId;

  if (!clientId && req.query.state) {
    const parsedState = parseOAuthState(req.query.state);
    clientId = parsedState.clientId;

    if (!clientId && parsedState.redirect) {
      const match = parsedState.redirect.match(/\/client\/([^/]+)/);
      if (match) clientId = match[1];
    }
  }

  return clientId;
}

function resolveRequestedRedirect(req, clientId) {
  if (typeof req.query.redirect === "string" && req.query.redirect) {
    return req.query.redirect;
  }

  const parsedState = parseOAuthState(req.query.state);
  if (typeof parsedState.redirect === "string" && parsedState.redirect) {
    return parsedState.redirect;
  }

  return clientId
    ? `/broker/client/${clientId}/connections`
    : "/broker/companies";
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

async function getWorkspaceCompanyName(clientId) {
  if (!clientId) return null;

  try {
    const result = await db.query("SELECT name FROM companies WHERE id = ?", [
      clientId,
    ]);
    return result?.rows?.[0]?.name || null;
  } catch (error) {
    console.error("Failed to fetch workspace company name:", error.message);
    return null;
  }
}

// GET /refresh-token - Refresh access token for a specific client
router.get("/refresh-token", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    return res.status(400).json({ error: "Missing Client ID" });
  }

  await loadQBConfig(clientId);
  const qb = getQBConfig(clientId);

  if (!qb.refreshToken || !qb.basicToken) {
    return res.status(400).json({
      error: `QuickBooks not connected for client ${clientId}`,
    });
  }

  try {
    logQuickBooksDebug("oauth_refresh_route_started", {
      clientId,
      realmId: qb.realmId || null,
      oauthClientId: qb.oauthClientId ? maskValue(qb.oauthClientId) : null,
    });

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

    await updateTokens(
      clientId,
      response.data.access_token,
      response.data.refresh_token,
      response.data.expires_in,
    );

    logQuickBooksDebug("oauth_refresh_route_completed", {
      clientId,
      realmId: qb.realmId || null,
      accessToken: maskValue(response.data.access_token),
      refreshToken: maskValue(response.data.refresh_token),
      expiresIn: response.data.expires_in,
    });

    return res.json({
      success: true,
      message: "Tokens refreshed successfully",
      expiresIn: response.data.expires_in,
      lastSynced: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      `Token refresh failed for client ${clientId}:`,
      error.response?.data || error.message,
    );
    if (error.response)
      return res.status(error.response.status).json(error.response.data);
    return res
      .status(500)
      .json({ error: "Failed to refresh token", details: error.message });
  }
});

// GET /api/auth/quickbooks - Start OAuth flow
router.get("/api/auth/quickbooks", (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    return res
      .status(400)
      .json({ error: "Cannot start OAuth without Client ID" });
  }

  const qb = getQBConfig(clientId);
  const qbClientId = qb.clientId || process.env.QB_CLIENT_ID;
  const qbClientSecret = qb.clientSecret || process.env.QB_CLIENT_SECRET;
  const appBaseUrl = getAppBaseUrl(req);
  const redirectUri =
    process.env.QB_REDIRECT_URI || `${appBaseUrl}/api/auth/callback`;
  const scope = "com.intuit.quickbooks.accounting";
  const redirectHash = resolveRequestedRedirect(req, clientId);

  if (!qbClientId || !qbClientSecret || !redirectUri) {
    return res.status(500).json({
      error:
        "QuickBooks OAuth is not configured. Check QB_CLIENT_ID, QB_CLIENT_SECRET, and QB_REDIRECT_URI.",
    });
  }

  const state = buildOAuthState(redirectHash, clientId);
  const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${qbClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;

  logQuickBooksDebug("oauth_start", {
    clientId,
    redirectHash,
    redirectUri,
    qbClientId: maskValue(qbClientId),
    environment: qb.baseUrl?.includes("sandbox") ? "sandbox" : "production",
  });
  logQuickBooksDebug("oauth_redirect_created", {
    clientId,
    authUrl,
  });

  console.log(`Redirecting to QuickBooks OAuth for client: ${clientId}...`);
  res.redirect(authUrl);
});

// GET /api/auth/callback - Handle OAuth redirect
router.get("/api/auth/callback", async (req, res) => {
  const { code, realmId, state: rawState } = req.query;
  const appBaseUrl = getAppBaseUrl(req);
  const frontendUrl = getFrontendBaseUrl(req);
  const state = parseOAuthState(rawState);

  let clientId = state.clientId;

  if (!clientId && state.redirect) {
    const match = state.redirect.match(/\/client\/([^/]+)/);
    if (match) clientId = match[1];
  }

  const redirectHash = state.redirect || "/broker/companies";

  logQuickBooksDebug("oauth_callback_received", {
    clientId: clientId || null,
    realmId: realmId || null,
    redirectHash,
    code: code ? maskValue(code) : null,
  });

  if (!code || !realmId || !clientId) {
    console.error("Callback missing code, realmId, or clientId");
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
  if (!qbClientId || !qbClientSecret) {
    return res.redirect(
      buildFrontendHashUrl(
        frontendUrl,
        redirectHash,
        "?qbStatus=error&qbMessage=QuickBooks+OAuth+credentials+are+not+configured",
      ),
    );
  }

  const basicToken = Buffer.from(`${qbClientId}:${qbClientSecret}`).toString(
    "base64",
  );
  const redirectUri =
    process.env.QB_REDIRECT_URI || `${appBaseUrl}/api/auth/callback`;

  try {
    const workspaceCompanyName = await getWorkspaceCompanyName(clientId);
    if (!workspaceCompanyName) {
      return res.redirect(
        buildFrontendHashUrl(
          frontendUrl,
          redirectHash,
          `?qbStatus=error&qbMessage=${encodeURIComponent("Workspace company could not be identified. Please retry from the selected company connection page.")}`,
        ),
      );
    }

    logQuickBooksDebug("oauth_token_exchange_started", {
      clientId,
      realmId,
      redirectUri,
      qbClientId: maskValue(qbClientId),
    });

    const tokenResponse = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
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

    logQuickBooksDebug("oauth_token_exchange_completed", {
      clientId,
      realmId,
      accessToken: maskValue(tokenResponse.data.access_token),
      refreshToken: maskValue(tokenResponse.data.refresh_token),
      expiresIn: tokenResponse.data.expires_in,
    });

    let quickbooksCompanyName = null;
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
      if (info?.CompanyName) {
        quickbooksCompanyName = info.CompanyName;
      }
    } catch (companyErr) {
      console.warn("Could not fetch company info:", companyErr.message);
    }

    if (!quickbooksCompanyName) {
      await disconnectConfig(clientId);
      return res.redirect(
        buildFrontendHashUrl(
          frontendUrl,
          redirectHash,
          `?qbStatus=error&qbMessage=${encodeURIComponent("Unable to verify QuickBooks company name. Connection was not established.")}`,
        ),
      );
    }

    const now = new Date().toISOString();
    const tokenExpiresAt = new Date(
      Date.now() + (tokenResponse.data.expires_in || 3600) * 1000,
    ).toISOString();

    const tokenData = {
      realmId,
      accessToken: tokenResponse.data.access_token,
      refreshToken: tokenResponse.data.refresh_token,
      basicToken,
      companyId: realmId,
      companyName: quickbooksCompanyName,
      connectedAt: now,
      lastSynced: now,
      tokenExpiresAt,
      environment: qb.baseUrl?.includes("sandbox") ? "sandbox" : "production",
      syncedEntities: [
        "Customers",
        "Invoices",
        "Balance Sheet",
        "General Ledger",
        "Profit and Loss",
      ],
      oauthClientId: qbClientId,
      redirectUri,
    };

    logQuickBooksDebug("oauth_realm_storage_started", {
      clientId,
      realmId,
      quickbooksCompanyName,
      oauthClientId: maskValue(qbClientId),
    });

    await setQBConfig(clientId, tokenData);

    logQuickBooksDebug("oauth_realm_storage_completed", {
      clientId,
      realmId,
      quickbooksCompanyName,
    });

    console.log(
      `Connected to Company: ${quickbooksCompanyName} for Client: ${clientId}`,
    );
    console.log(`QuickBooks authentication successful for Client: ${clientId}`);

    return res.redirect(
      buildFrontendHashUrl(frontendUrl, redirectHash, "?qbStatus=success"),
    );
  } catch (error) {
    console.error(
      "QuickBooks Callback Error:",
      error.response?.data || error.message,
    );
    const qbMessage =
      error.code === "QB_REALM_ALREADY_LINKED"
        ? encodeURIComponent(
            "This QuickBooks company is already linked to another DataHub company. Disconnect the old link first or choose a different sandbox company.",
          )
        : "OAuth+exchange+failed";
    return res.redirect(
      buildFrontendHashUrl(
        frontendUrl,
        redirectHash,
        `?qbStatus=error&qbMessage=${qbMessage}`,
      ),
    );
  }
});

// GET /api/auth/status - Scoped connection status
router.get("/api/auth/status", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    return res.json({
      success: true,
      isConnected: false,
      message: "No Client ID provided",
    });
  }

  await loadQBConfig(clientId);
  const qb = getQBConfig(clientId);
  const isConnected = !!(qb.accessToken && qb.realmId);

  if (!isConnected) {
    return res.json({ success: true, isConnected: false, syncedEntities: [] });
  }

  const workspaceCompanyName = await getWorkspaceCompanyName(clientId);
  const quickbooksCompanyName = qb.companyName || null;

  return res.json({
    success: true,
    isConnected: true,
    dataHubCompanyId: qb.dataHubCompanyId || clientId,
    companyName: quickbooksCompanyName,
    workspaceCompanyName: workspaceCompanyName || null,
    companyId: qb.companyId || qb.realmId,
    realmId: qb.realmId || null,
    environment: qb.environment || "production",
    connectedAt: qb.connectedAt || null,
    lastSynced: qb.lastSynced || null,
    tokenExpiresAt: qb.tokenExpiresAt || null,
    syncedEntities: qb.syncedEntities || [],
    configuredClientId: qb.clientId ? maskValue(qb.clientId) : null,
    storedOAuthClientId: qb.oauthClientId ? maskValue(qb.oauthClientId) : null,
    hasCredentialMismatch: Boolean(qb.hasCredentialMismatch),
  });
});

// GET /api/auth/disconnect - Scoped disconnect
router.get("/api/auth/disconnect", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "Missing Client ID" });

  await disconnectConfig(clientId);
  logQuickBooksDebug("oauth_disconnect_completed", {
    clientId,
  });

  return res.json({ success: true, message: "Disconnected successfully" });
});

module.exports = router;
