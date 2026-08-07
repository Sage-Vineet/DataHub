const jwt = require("jsonwebtoken");
const { getUserById } = require("../services/userService");
const { JWT_SECRET } = require("../config/secrets");

// In-process user cache to avoid a DB round-trip on every authenticated request.
// Entries expire after 60 s; the cache is bounded at 500 entries to limit memory use.
const _USER_CACHE_TTL_MS = 60 * 1000;
const _USER_CACHE_MAX = 500;
const _userCache = new Map();

function _getCachedUser(userId) {
  const entry = _userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > _USER_CACHE_TTL_MS) {
    _userCache.delete(userId);
    return null;
  }
  return entry.user;
}

function _setCachedUser(userId, user) {
  if (_userCache.size >= _USER_CACHE_MAX) {
    _userCache.delete(_userCache.keys().next().value);
  }
  _userCache.set(userId, { user, ts: Date.now() });
}

const _userPromiseCache = new Map();


function extractToken(req, { allowQueryToken = false } = {}) {
  const authorization = req.headers.authorization || "";
  if (authorization.startsWith("Bearer ")) {
    return authorization.slice(7);
  }

  const alternateHeaders = [
    req.headers["x-access-token"],
    req.headers["x-auth-token"],
    req.headers["x-token"],
  ];

  const headerToken = alternateHeaders.find((value) => typeof value === "string" && value.trim());
  if (headerToken) return headerToken.trim();

  // By default we do NOT read the token from the query string: query params leak
  // into server access logs, browser history, and Referer headers. The single
  // exception is top-level browser navigations that cannot set an Authorization
  // header (e.g. the QuickBooks OAuth-start redirect), which opt in explicitly.
  if (allowQueryToken) {
    const queryToken = req.query?.token || req.query?.access_token || req.query?.accessToken;
    if (typeof queryToken === "string" && queryToken.trim()) {
      return queryToken.trim();
    }
  }

  return null;
}

// Factory so most routes get header-only auth while a whitelisted few (browser
// redirects) can opt into query-string tokens.
function makeRequireAuth({ allowQueryToken = false } = {}) {
  return async function requireAuth(req, res, next) {
  const token = extractToken(req, { allowQueryToken });

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { clockTolerance: 30 });

    const cached = _getCachedUser(payload.sub);
    if (cached) {
      req.user = cached;
      return next();
    }

    let userPromise = _userPromiseCache.get(payload.sub);
    if (!userPromise) {
      userPromise = getUserById(payload.sub).finally(() => {
        _userPromiseCache.delete(payload.sub);
      });
      _userPromiseCache.set(payload.sub, userPromise);
    }

    const user = await userPromise;

    if (!user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    _setCachedUser(payload.sub, user);
    req.user = user;
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
  };
}

// Default: header-only auth for all API/data routes.
const requireAuth = makeRequireAuth();
// Whitelisted variant for top-level browser redirects that cannot set headers.
const requireAuthAllowQueryToken = makeRequireAuth({ allowQueryToken: true });

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${roles.join(" or ")}. Your role: ${req.user.role}.`,
      });
    }
    return next();
  };
}

function invalidateUserCache(userId) {
  if (!userId) return;
  const key = String(userId);
  _userCache.delete(key);
  _userPromiseCache.delete(key);
}

module.exports = { requireAuth, requireAuthAllowQueryToken, requireRole, invalidateUserCache };
