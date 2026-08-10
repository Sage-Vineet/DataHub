/** Insecure JWT secret defaults that must never be accepted (audit C2). */
const INSECURE_DEFAULTS = new Set(["change_me", "changeme", "secret", ""]);

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  verificationTokenTtl: string;
  loginRateLimit: { windowMs: number; max: number };
  otp: {
    expiryMs: number;
    maxAttempts: number;
    maxResends: number;
    resendWindowMs: number;
  };
  defaultFolders: readonly string[];
}

/**
 * Load auth config from the environment, failing closed if the signing secret
 * is missing or an insecure default (audit C2). The same secret + 7d HS256
 * shape as legacy is used so tokens are cross-valid during cutover (design D3).
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const secret = env.JWT_SECRET;
  if (!secret || INSECURE_DEFAULTS.has(secret.trim().toLowerCase())) {
    throw new Error(
      "JWT_SECRET is not set (or is an insecure default). Refusing to start — set a strong JWT_SECRET.",
    );
  }
  return {
    jwtSecret: secret,
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? "7d",
    verificationTokenTtl: "15m",
    loginRateLimit: {
      windowMs: Number(env.AUTH_LOGIN_RATE_WINDOW_MS ?? 15 * 60 * 1000),
      max: Number(env.AUTH_LOGIN_RATE_MAX ?? 10),
    },
    otp: {
      expiryMs: 10 * 60 * 1000,
      maxAttempts: 5,
      maxResends: 3,
      resendWindowMs: 10 * 60 * 1000,
    },
    defaultFolders: ["Finance", "Compliance", "HR", "Legal", "M&A", "Tax", "Other"],
  };
}
