// Centralized required-secret handling.
//
// JWT_SECRET must be provided via the environment. Previously every jwt.sign/
// jwt.verify call fell back to the literal string "change_me", which meant a
// deployment with a missing JWT_SECRET would silently sign and accept tokens
// with a publicly-known key — allowing anyone to forge a token for any user.
// We now fail closed: a missing or insecure secret is a fatal misconfiguration.

const INSECURE_DEFAULTS = new Set(["change_me", "changeme", "secret", ""]);

function requireJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || INSECURE_DEFAULTS.has(secret.trim().toLowerCase())) {
    throw new Error(
      "JWT_SECRET is not set (or is an insecure default). Set a strong, random " +
      "JWT_SECRET in the environment before starting the server."
    );
  }
  return secret;
}

// Resolve once at module load so a misconfigured deployment fails fast on boot
// rather than on the first auth request.
const JWT_SECRET = requireJwtSecret();

module.exports = { JWT_SECRET, requireJwtSecret };
