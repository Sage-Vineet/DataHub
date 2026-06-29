const jwt = require("jsonwebtoken");
const { getUserById } = require("../services/userService");

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


function extractToken(req) {
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

  const queryToken = req.query?.token || req.query?.access_token || req.query?.accessToken;
  if (typeof queryToken === "string" && queryToken.trim()) {
    return queryToken.trim();
  }

  return null;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "change_me", { clockTolerance: 30 });

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
}

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

module.exports = { requireAuth, requireRole, invalidateUserCache };
