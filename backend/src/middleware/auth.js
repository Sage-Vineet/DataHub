const jwt = require("jsonwebtoken");
const { getUserById } = require("../services/userService");

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
    const payload = jwt.verify(token, process.env.JWT_SECRET || "change_me");
    const user = await getUserById(payload.sub);

    if (!user) {
      return res.status(401).json({ error: "Invalid token" });
    }

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
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
