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

// ────────────────────────────────────────────────────────────
// Cookie-based token persistence for Vercel serverless
// ────────────────────────────────────────────────────────────

const COOKIE_NAME = "qb_tokens";
const COOKIE_SECRET = process.env.QB_CLIENT_SECRET || "fallback-secret-key-32chars!!!!!";

function encrypt(text) {
  const key = crypto.scryptSync(COOKIE_SECRET, "salt", 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(text) {
  try {
    const key = crypto.scryptSync(COOKIE_SECRET, "salt", 32);
    const [ivHex, encryptedHex] = text.split(":");
    if (!ivHex || !encryptedHex) return null;
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (e) {
    console.error("Cookie decryption failed:", e.message);
    return null;
  }
}

function setTokenCookie(res, tokens) {
  const payload = JSON.stringify(tokens);
  const encrypted = encrypt(payload);
  const isProduction = process.env.NODE_ENV === "production" || process.env.VERCEL;
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=${encrypted}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${isProduction ? "; Secure" : ""}`,
  ]);
}

function clearTokenCookie(res) {
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
  ]);
}

function getTokensFromCookie(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const decrypted = decrypt(match[1]);
  if (!decrypted) return null;
  try {
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// Middleware: hydrate qbConfig from cookie if available (for Vercel)
router.use((req, _res, next) => {
  if (process.env.VERCEL) {
    const cookieTokens = getTokensFromCookie(req);
    if (cookieTokens && cookieTokens.accessToken) {
      const currentConfig = getQBConfig();
      // Only apply cookie tokens if they differ from env var defaults (meaning they're fresh)
      if (cookieTokens.accessToken !== currentConfig.accessToken) {
        setQBConfig({
          realmId: cookieTokens.realmId,
          accessToken: cookieTokens.accessToken,
          refreshToken: cookieTokens.refreshToken,
          basicToken: cookieTokens.basicToken,
          companyName: cookieTokens.companyName,
          companyId: cookieTokens.companyId,
          environment: cookieTokens.environment,
          connectedAt: cookieTokens.connectedAt,
          lastSynced: cookieTokens.lastSynced,
          tokenExpiresAt: cookieTokens.tokenExpiresAt,
          syncedEntities: cookieTokens.syncedEntities,
        });
      }
    }
  }
  next();
});

function getAppBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (host) return `${proto}://${host}`;
  return (process.env.CORS_ORIGIN || "http://localhost:3000").replace(/\/$/, "");
}

function getFrontendBaseUrl(req) {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/$/, "");
  const origin = req.headers.origin;
  if (origin) return origin.replace(/\/$/, "");
  return (process.env.CORS_ORIGIN || "http://localhost:5173").replace(/\/$/, "");
}

function buildFrontendHashUrl(baseUrl, hashPath, searchParams = "") {
  const normalizedHash = hashPath?.startsWith("/") ? hashPath : "/broker/companies";
  return `${baseUrl}/#${normalizedHash}${searchParams}`;
}

// ────────────────────────────────────────────────────────────
// GET /refresh-token — Refresh access token using refresh token
// ────────────────────────────────────────────────────────────
/**
 * @swagger
 * /refresh-token:
 *   get:
 *     summary: Refresh QuickBooks Token
 *     responses:
 *       200:
 *         description: Token refreshed
 */
router.get("/refresh-token", async (req, res) => {
  const qb = getQBConfig();

  // Validate required config
  if (!qb.refreshToken || !qb.basicToken) {
    return res.status(400).json({
      error:
        "Missing refresh token or basic token. Please check configuration.",
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

    // Update tokens with expiry tracking
    updateTokens(
      response.data.access_token,
      response.data.refresh_token,
      response.data.expires_in,
    );

    // Also persist to cookie for Vercel
    const updatedConfig = getQBConfig();
    setTokenCookie(res, {
      realmId: updatedConfig.realmId,
      accessToken: updatedConfig.accessToken,
      refreshToken: updatedConfig.refreshToken,
      basicToken: updatedConfig.basicToken,
      companyName: updatedConfig.companyName,
      companyId: updatedConfig.companyId,
      environment: updatedConfig.environment,
      connectedAt: updatedConfig.connectedAt,
      lastSynced: updatedConfig.lastSynced,
      tokenExpiresAt: updatedConfig.tokenExpiresAt,
      syncedEntities: updatedConfig.syncedEntities,
    });

    // Do not return raw tokens to the caller to maintain security
    return res.json({
      success: true,
      message: "Tokens refreshed successfully",
      expiresIn: response.data.expires_in,
      lastSynced: new Date().toISOString()
    });
  } catch (error) {
    console.error(
      "❌ Token refresh failed:",
      error.response?.data || error.message,
    );

    // Return the original error response from QuickBooks
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    // Fallback error response
    return res.status(500).json({
      error: "Failed to refresh token",
      details: error.message,
    });
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/auth/quickbooks — Start OAuth flow
// ────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/auth/quickbooks:
 *   get:
 *     summary: Start QuickBooks OAuth flow
 */
router.get("/api/auth/quickbooks", (req, res) => {
  const qb = getQBConfig();
  const clientId = qb.clientId || process.env.QB_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({
      error: "QuickBooks client ID is missing. Set QB_CLIENT_ID in backend/.env",
    });
  }
  const appBaseUrl = getAppBaseUrl(req);
  const redirectUri = process.env.QB_REDIRECT_URI || `${appBaseUrl}/api/auth/callback`;
  const scope = "com.intuit.quickbooks.accounting";
  const state = encodeURIComponent(req.query.state || "/broker/companies");

  const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;

  console.log("🔗 Redirecting to QuickBooks OAuth...");
  res.redirect(authUrl);
});

// ────────────────────────────────────────────────────────────
// GET /api/auth/callback — Handle OAuth redirect
// ────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/auth/callback:
 *   get:
 *     summary: QuickBooks OAuth callback
 */
router.get("/api/auth/callback", async (req, res) => {
  const { code, realmId, state } = req.query;
  const appBaseUrl = getAppBaseUrl(req);
  const frontendUrl = getFrontendBaseUrl(req);
  const redirectHash = state ? decodeURIComponent(state) : "/broker/companies";

  if (!code || !realmId) {
    console.error("❌ Callback missing code or realmId");
    return res.redirect(
      buildFrontendHashUrl(frontendUrl, redirectHash, "?qbStatus=error&qbMessage=Missing+code+or+realmId"),
    );
  }

  const qb = getQBConfig();
  const clientId = qb.clientId || process.env.QB_CLIENT_ID;
  const clientSecret = qb.clientSecret || process.env.QB_CLIENT_SECRET;
  const basicToken = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );
  const redirectUri = process.env.QB_REDIRECT_URI || `${appBaseUrl}/api/auth/callback`;

  try {
    // 1. Exchange authorization code for tokens
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

    // 2. Store tokens + connection metadata (in-memory + /tmp file)
    setQBConfig(tokenData);

    // 3. Fetch company info (non-blocking — connection is valid even if this fails)
    let companyName = `Company ${realmId}`;
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
        companyName = info.CompanyName;
        setQBConfig({ companyName });
        console.log(`🏢 Company: ${info.CompanyName}`);
      }
    } catch (companyErr) {
      console.warn("⚠️ Could not fetch company info:", companyErr.message);
      setQBConfig({ companyName });
    }

    // 4. Persist tokens to encrypted cookie (critical for Vercel serverless)
    const updatedConfig = getQBConfig();
    setTokenCookie(res, {
      realmId: updatedConfig.realmId,
      accessToken: updatedConfig.accessToken,
      refreshToken: updatedConfig.refreshToken,
      basicToken: updatedConfig.basicToken,
      companyName: updatedConfig.companyName,
      companyId: updatedConfig.companyId,
      environment: updatedConfig.environment,
      connectedAt: updatedConfig.connectedAt,
      lastSynced: updatedConfig.lastSynced,
      tokenExpiresAt: updatedConfig.tokenExpiresAt,
      syncedEntities: updatedConfig.syncedEntities,
    });

    console.log("✅ QuickBooks authentication successful.");

    // 5. Redirect to frontend connections page
    return res.redirect(buildFrontendHashUrl(frontendUrl, redirectHash, "?qbStatus=success"));
  } catch (error) {
    console.error(
      "❌ QuickBooks Callback Error:",
      error.response?.data || error.message,
    );
    return res.redirect(
      buildFrontendHashUrl(frontendUrl, redirectHash, "?qbStatus=error&qbMessage=OAuth+exchange+failed"),
    );
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/auth/status — Connection status + metadata
// ────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/auth/status:
 *   get:
 *     summary: Get QuickBooks connection status and metadata
 *     responses:
 *       200:
 *         description: Connection status with full details
 */
router.get("/api/auth/status", (req, res) => {
  const qb = getQBConfig();
  const isConnected = !!(qb.accessToken && qb.realmId);

  if (!isConnected) {
    return res.json({
      success: true,
      isConnected: false,
      syncedEntities: [],
    });
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
// GET /api/auth/disconnect — Fully disconnect integration
// ────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/auth/disconnect:
 *   get:
 *     summary: Disconnect from QuickBooks and clear all stored data
 */
router.get("/api/auth/disconnect", (req, res) => {
  disconnectConfig();
  clearTokenCookie(res);

  return res.json({
    success: true,
    message: "Disconnected successfully",
  });
});

module.exports = router;
