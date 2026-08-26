import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { randomUUID } from "node:crypto";
import { bearer, emailOTP } from "better-auth/plugins";
import { schema } from "@datahub/db";
import type { Db } from "@datahub/db";
import type { Emailer } from "./ports.js";

/** Insecure signing-secret defaults that must never be accepted (audit C2). */
const INSECURE_DEFAULTS = new Set(["change_me", "changeme", "secret", ""]);

export interface BetterAuthConfig {
  /** Signing secret. Reuses the legacy `JWT_SECRET` so the value is one source. */
  secret: string;
  /** Public base URL of the API (Better Auth uses it for cookies/links). */
  baseURL: string;
  /** SPA origins allowed to use credentialed requests. */
  trustedOrigins: string[];
}

/**
 * Load Better Auth config from the environment, failing closed if the secret is
 * missing or an insecure default (audit C2, parity with loadAuthConfig).
 */
export function loadBetterAuthConfig(env: NodeJS.ProcessEnv): BetterAuthConfig {
  const secret = env.JWT_SECRET;
  if (!secret || INSECURE_DEFAULTS.has(secret.trim().toLowerCase())) {
    throw new Error(
      "JWT_SECRET is not set (or is an insecure default). Refusing to start — set a strong JWT_SECRET.",
    );
  }
  const trusted = (env.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    secret,
    baseURL: env.BETTER_AUTH_URL ?? `http://localhost:${env.PORT ?? "8080"}`,
    trustedOrigins: trusted,
  };
}

/**
 * A narrow, hand-written facade over the Better Auth server API — just the
 * endpoints this module calls. Better Auth's fully-inferred type leaks zod
 * internals (TS2742) and its plugin methods aren't portably nameable, so we type
 * the surface we use and cast the instance to it. Runtime behavior is unchanged.
 */
export interface BetterAuth {
  api: {
    signInEmail(ctx: {
      body: { email: string; password: string };
      returnHeaders: true;
    }): Promise<{ headers: Headers; response: unknown }>;
    signUpEmail(ctx: {
      body: { email: string; password: string; name: string };
      returnHeaders: true;
    }): Promise<{ headers: Headers; response: unknown }>;
    getSession(ctx: { headers: Headers }): Promise<{ user?: unknown; session?: unknown } | null>;
    signOut(ctx: {
      headers: Headers;
      returnHeaders: true;
    }): Promise<{ headers: Headers; response: unknown }>;
    requestPasswordResetEmailOTP(ctx: { body: { email: string } }): Promise<unknown>;
    resetPasswordEmailOTP(ctx: {
      body: { email: string; otp: string; password: string };
    }): Promise<unknown>;
    sendVerificationOTP(ctx: { body: { email: string; type: string } }): Promise<unknown>;
    verifyEmailOTP(ctx: { body: { email: string; otp: string } }): Promise<unknown>;
    revokeSession(ctx: { body: { token: string }; headers: Headers }): Promise<unknown>;
    listSessions(ctx: { headers: Headers }): Promise<unknown>;
  };
}

export interface CreateBetterAuthOptions {
  db: Db;
  emailer: Emailer;
  config: BetterAuthConfig;
}

/**
 * Build the Better Auth instance (ADR-0007): Drizzle adapter over our own
 * Postgres, bcrypt password verification for legacy-hash parity (D3), DB-backed
 * httpOnly cookie sessions (D4), and the email-OTP reset flow wired to a real
 * emailer (D5). The `user` model maps onto our `auth_user` table with the
 * business fields (role / companyId / status) surfaced on the session (D2/D6).
 */
export function createBetterAuth(opts: CreateBetterAuthOptions): BetterAuth {
  const { db, emailer, config } = opts;

  const options = {
    appName: "DataHub",
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    // Map the "user" model to our auth_user table + surface business fields.
    user: {
      modelName: "authUser",
      additionalFields: {
        role: { type: "string", required: false, input: false },
        companyId: { type: "string", required: false, input: false },
        status: { type: "string", required: false, input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // Parity (D3): existing bcrypt hashes verify verbatim; new/changed
      // passwords are re-hashed with bcrypt so the store stays uniform.
      password: {
        hash: (password: string) => bcrypt.hash(password, 10),
        verify: ({ password, hash }: { password: string; hash: string }) =>
          bcrypt.compare(password, hash),
      },
    },
    session: {
      // DB-backed sessions → revocable (M1). Cookie flags set below (D4).
      expiresIn: 60 * 60 * 24 * 7, // 7 days, parity with legacy JWT TTL
      updateAge: 60 * 60 * 24, // refresh once a day
    },
    advanced: {
      cookiePrefix: "datahub",
      /**
       * Generate UUIDs ourselves, rather than Better Auth's default nanoid.
       *
       * `auth_user` and `users` are keyed by the SAME value — the invariant the
       * backfill establishes so `user_companies` and `folders` keep lining up.
       * `users.id` is a `uuid` column, so a nanoid identity cannot have a
       * business row at all, and broker signup failed on it.
       *
       * A function, not the string `"uuid"`: that string tells the Drizzle
       * adapter the *database* supplies the id, so it inserts DEFAULT into
       * `auth_user.id`, which has no default and is NOT NULL.
       */
      database: { generateId: () => randomUUID() },
      // Sessions are httpOnly by default; Secure + SameSite hardened here (M2/M3).
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: process.env.NODE_ENV === "production",
      },
    },
    plugins: [
      // Reset / verification codes delivered through the injected emailer (D5).
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60, // 10 minutes, parity with legacy OTP
        async sendVerificationOTP({ email, otp }: { email: string; otp: string }) {
          await emailer.sendOtp(email, otp);
        },
      }),
      // Allows the session token to also be presented as a Bearer header, for
      // API clients that don't carry cookies (transitional legacy interop).
      bearer(),
    ],
  } satisfies BetterAuthOptions;

  return betterAuth(options) as unknown as BetterAuth;
}
