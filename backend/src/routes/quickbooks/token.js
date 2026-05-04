const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { supabase } = require("../../db");
const {
  getQBConfig,
  loadQBConfig,
  updateTokens,
  setQBConfig,
  disconnectConfig,
} = require("../../qbconfig");
const { logQuickBooksDebug, maskValue } = require("../../quickbooksLogger");

const { requireAuth } = require("../../middleware/auth");
const router = express.Router();

// Public callback (OAuth redirect)
// router.get("/api/auth/callback", ...) -> defined later

// Protected routes
// router.get("/api/auth/quickbooks", requireAuth, ...)
// router.get("/api/auth/status", requireAuth, ...)
// router.get("/api/auth/disconnect", requireAuth, ...)
// router.get("/refresh-token", requireAuth, ...)

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
      const parsed = JSON.parse(candidate);
      // Support both clientId and companyId for backward compatibility
      if (parsed.companyId && !parsed.clientId) parsed.clientId = parsed.companyId;
      if (parsed.clientId && !parsed.companyId) parsed.companyId = parsed.clientId;
      return parsed;
    } catch (_) {
      // Keep trying.
    }
  }

  return { redirect: String(rawState) };
}

function buildOAuthState(redirectHash, companyId, role = "broker", userId = null) {
  return encodeURIComponent(
    JSON.stringify({
      redirect: redirectHash || "/broker/companies",
      companyId,
      clientId: companyId, // for backward compat
      role,
      userId,
      nonce: crypto.randomBytes(16).toString("hex"),
    }),
  );
}

/**
 * Extract Client ID from headers
 */
function getClientId(req) {
  let clientId = req.headers["x-client-id"] || req.query.clientId;

  // Fallback 1: Authenticated user's company
  if (!clientId && req.user) {
    clientId = req.user.company_id || (req.user.company_ids && req.user.company_ids[0]);
  }

  // Fallback 2: OAuth State
  if (!clientId && req.query.state) {
    const parsedState = parseOAuthState(req.query.state);
    clientId = parsedState.clientId;

    if (!clientId && parsedState.redirect) {
      const match = parsedState.redirect.match(/\/client\/([^/]+)/);
      // Skip if the segment is a known UI route like 'connections'
      if (match && match[1] !== 'connections' && match[1] !== 'dashboard') {
        clientId = match[1];
      }
    }
  }

  // Final Validation: Ensure it's a valid UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (clientId && !uuidRegex.test(clientId)) {
    console.warn(`[getClientId] Rejected invalid UUID: ${clientId}`);
    return null;
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
    const { data, error } = await supabase
      .from("companies")
      .select("name")
      .eq("id", clientId)
      .maybeSingle();

    if (error) throw error;
    return data?.name || null;
  } catch (error) {
    console.error("Failed to fetch workspace company name:", error.message);
    return null;
  }
}


// GET /refresh-token - Refresh access token for a specific client
router.get("/refresh-token", requireAuth, async (req, res) => {
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
        proxy: false,
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
router.get("/api/auth/quickbooks", requireAuth, async (req, res) => {
  let clientId = getClientId(req);

  // Proactive Identification: If no clientId, try to find or create one for the user
  if (!clientId && req.user) {
    try {
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("email, company_id")
        .eq("id", req.user.id)
        .maybeSingle();

      if (userError) throw userError;

      if (user?.company_id) {
        clientId = user.company_id;
      } else if (user?.email) {
        // Try finding by email
        const { data: existingComp } = await supabase
          .from("companies")
          .select("id")
          .eq("contact_email", user.email)
          .maybeSingle();

        if (existingComp) {
          clientId = existingComp.id;
        } else {
          // Create a placeholder company
          const name = (req.user.name || user.email.split('@')[0]) + "'s Company";
          console.log(`[OAuth Start] Provisioning temporary company: ${name}`);

          const { data: created, error: insertError } = await supabase
            .from("companies")
            .insert({
              name,
              industry: "Financial Services",
              contact_name: req.user.name || "Client",
              contact_email: user.email,
              contact_phone: ""
            })
            .select("id")
            .single();

          if (insertError) throw insertError;
          clientId = created?.id;
        }

        if (clientId) {
          await supabase.from("users").update({ company_id: clientId }).eq("id", req.user.id);
          await supabase.from("user_companies").upsert({ user_id: req.user.id, company_id: clientId }, { onConflict: "user_id,company_id" });
          req.user.company_id = clientId; // Update local session object
        }
      }
    } catch (err) {
      console.warn("[OAuth Start] Proactive company creation failed:", err.message);
    }
  }


  if (!clientId) {
    console.log(`[OAuth Start] Proceeding with null clientId. Dynamic provisioning will continue at callback.`);
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

  const state = buildOAuthState(
    redirectHash,
    clientId,
    req.user?.role === "buyer" ? "client" : req.user?.role || "broker",
    req.user?.id
  );

  // Force company selection screen: 
  // 'consent' ensures the user sees the permissions screen
  // 'login' forces re-authentication if session is stale
  // 'select_company' is a known (if semi-undocumented) param to force realm picker
  const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${qbClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}&prompt=login%20consent%20select_company`;
  console.log(redirectUri);

  logQuickBooksDebug("oauth_start", {
    clientId,
    redirectHash,
    redirectUri,
    qbClientId: maskValue(qbClientId),
    environment: qb.baseUrl?.includes("sandbox") ? "sandbox" : "production",
  });
  logQuickBooksDebug("oauth_redirect_created", {
    clientId,
    authUrl: authUrl.split('&state=')[0] + '&state=...' // Log URL without sensitive state
  });

  console.log(`[OAuth Start] Redirecting to QuickBooks for client ${clientId} with prompt=login consent select_company`);
  res.redirect(authUrl);
});

// GET /api/auth/callback - Handle OAuth redirect
router.get("/api/auth/callback", async (req, res) => {
  const { code, realmId, state: rawState } = req.query;
  const appBaseUrl = getAppBaseUrl(req);
  const frontendUrl = getFrontendBaseUrl(req);
  const state = parseOAuthState(rawState);

  let clientId = state.companyId || state.clientId;
  const userId = state.userId || req.user?.id;

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
        proxy: false,
      },
    );


    logQuickBooksDebug("oauth_token_exchange_completed", {
      clientId,
      realmId,
      accessToken: maskValue(tokenResponse.data.access_token),
      refreshToken: maskValue(tokenResponse.data.refresh_token),
      expiresIn: tokenResponse.data.expires_in,
    });

    // 1. Recovery: If clientId is missing, check if this realm is already linked to a company
    if (!clientId && realmId) {
      const { getQuickBooksConnectionByRealmId } = require("../../services/quickbooksConnectionStore");
      const existing = await getQuickBooksConnectionByRealmId(realmId);
      if (existing) {
        clientId = existing.dataHubCompanyId;
        console.log(`[OAuth Callback] Recovered clientId ${clientId} from existing realm link for ${realmId}`);
      }
    }

    let quickbooksCompanyName = null;
    try {
      const companyRes = await axios.get(
        `${qb.baseUrl}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`,
        {
          headers: {
            Authorization: `Bearer ${tokenResponse.data.access_token}`,
            Accept: "application/json",
          },
          proxy: false,
        },
      );


      const info = companyRes.data.CompanyInfo;
      if (info?.CompanyName) {
        quickbooksCompanyName = info.CompanyName;
      }
    } catch (companyErr) {
      console.warn("Could not fetch company info:", companyErr.message);
    }

    // 2. Recovery: Dynamic Company Creation (For new sellers/clients)
    if (!clientId && userId) {
      console.log(`[OAuth Callback] No clientId found for user ${userId}. Attempting dynamic provisioning...`);
      try {
        const { data: user } = await supabase
          .from("users")
          .select("email, company_id")
          .eq("id", userId)
          .maybeSingle();

        if (user) {
          if (user.company_id) {
            clientId = user.company_id;
            console.log(`[OAuth Callback] Found existing company_id ${clientId} on user profile.`);
          } else {
            // Check if a company with this email already exists
            const { data: existingComp } = await supabase
              .from("companies")
              .select("id")
              .eq("contact_email", user.email)
              .maybeSingle();

            if (existingComp) {
              clientId = existingComp.id;
              console.log(`[OAuth Callback] Re-using existing company ${clientId} found by email.`);
            } else {
              const finalCompanyName = quickbooksCompanyName || "Connected Company";
              console.log(`[OAuth Callback] Creating new company: ${finalCompanyName}`);
              const { data: created, error: insertError } = await supabase
                .from("companies")
                .insert({
                  name: finalCompanyName,
                  industry: "Financial Services",
                  contact_name: "Client",
                  contact_email: user.email,
                  contact_phone: ""
                })
                .select("id")
                .single();

              if (insertError) throw insertError;
              clientId = created?.id;
            }

            if (clientId) {
              await supabase.from("users").update({ company_id: clientId }).eq("id", userId);
              await supabase.from("user_companies").upsert({ user_id: userId, company_id: clientId }, { onConflict: "user_id,company_id" });
              console.log(`[OAuth Callback] Successfully provisioned company ${clientId} for user ${userId}`);
            }
          }
        }
      } catch (err) {
        console.error("[OAuth Callback] Dynamic company creation failed:", err.message);
      }
    }

    // -------------------------------------------------------

    if (!clientId) {
      console.error("Callback missing clientId after attempt to recover.");
      return res.redirect(
        buildFrontendHashUrl(
          frontendUrl,
          redirectHash,
          "?qbStatus=error&qbMessage=Company+identification+failed",
        ),
      );
    }

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
      userId,
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
    console.error("❌ QuickBooks Callback Error Details:", {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      data: error.response?.data,
      stack: error.stack,
    });

    const qbMessage =
      error.code === "QB_REALM_ALREADY_LINKED"
        ? encodeURIComponent(
          "This QuickBooks company is already linked to another DataHub company.",
        )
        : encodeURIComponent(`OAuth exchange failed: ${error.message}`);

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
router.get("/api/auth/status", requireAuth, async (req, res) => {
  try {
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

    // DB flag is source of truth; token presence is secondary
    const hasTokens = !!(qb.accessToken && qb.realmId);
    const isConnected = hasTokens;

    console.log(`[QB Status] client=${clientId} | hasTokens=${hasTokens} | isConnected=${isConnected} | realmId=${qb.realmId || 'null'} | accessToken=${qb.accessToken ? 'present' : 'null'}`);

    // Always fetch sync status (available even when disconnected)
    let syncStatus = null;
    try {
      const { getSyncStatus } = require("../../services/quickbooksReportService");
      syncStatus = await getSyncStatus(clientId);
    } catch (syncErr) {
      console.warn("Failed to fetch sync status:", syncErr.message);
    }

    if (!isConnected) {
      // Edge case: if tokens exist but DB says disconnected, clean them
      if (qb.accessToken || qb.refreshToken) {
        console.warn(`[QB Status] Edge case: stale tokens found for disconnected client=${clientId}, ignoring them`);
      }
      return res.json({
        success: true,
        isConnected: false,
        syncedEntities: [],
        hasCachedData: syncStatus ? syncStatus.totalCachedReports > 0 : false,
        cachedReports: syncStatus ? syncStatus.reports : [],
        lastSyncedAt: syncStatus ? syncStatus.lastSyncedAt : null,
      });
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
      // Sync cache info
      hasCachedData: syncStatus ? syncStatus.totalCachedReports > 0 : false,
      cachedReports: syncStatus ? syncStatus.reports : [],
      lastCacheSyncedAt: syncStatus ? syncStatus.lastSyncedAt : null,
    });
  } catch (error) {
    console.error("Failed to fetch connection status:", error.message);
    // Return a safe error response instead of crashing the server
    return res.status(error.code === '22P02' ? 400 : 500).json({
      success: false,
      isConnected: false,
      error: "Status check failed",
      message: error.message
    });
  }
});

// GET /api/auth/disconnect - Scoped disconnect
router.get("/api/auth/disconnect", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "Missing Client ID" });

  console.log(`[QB Disconnect] API called for client: ${clientId}`);

  try {
    await disconnectConfig(clientId);
    logQuickBooksDebug("oauth_disconnect_completed", {
      clientId,
    });

    console.log(`[QB Disconnect] API response: success=true for client: ${clientId}`);
    return res.json({ success: true, message: "Disconnected successfully", isConnected: false });
  } catch (err) {
    console.error(`[QB Disconnect] API error for client ${clientId}:`, err.message);
    return res.status(500).json({ success: false, error: "Disconnect failed", message: err.message });
  }
});

module.exports = router;
