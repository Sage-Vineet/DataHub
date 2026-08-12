import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { fromNodeHeaders } from "better-auth/node";
import { auth as contracts } from "@datahub/contracts";
import type { AuthConfig } from "./config.js";
import type { BetterAuth } from "./better-auth.js";
import type { AuthRepository } from "./ports.js";
import { type BetterAuthUser, requireBetterAuth, resolveSessionUser, toSessionUser } from "./better-session.js";

const GENERIC_RESET = "If an account exists for that email, a reset code has been sent.";

/** Structural, zod-version-agnostic — reads the first validation message. */
function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

/** Better Auth throws APIError with a numeric status + message; normalise it. */
function errorStatus(err: unknown): { status: number; message: string } {
  const e = err as { statusCode?: number; status?: number; body?: { message?: string }; message?: string };
  const status = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : 400;
  return { status, message: e.body?.message ?? e.message ?? "Request failed." };
}

/** Copy Better Auth's Set-Cookie (session cookie set/clear) onto the Express response. */
function forwardSetCookie(headers: Headers, res: Response): void {
  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
}

/**
 * Post-login provisioning for client/buyer users (legacy parity): ensure the
 * company association + default folders exist. Mirrors the bespoke
 * AuthService.provisionClient, using the shared Drizzle repo.
 */
async function provisionClient(
  repo: AuthRepository,
  user: BetterAuthUser,
  defaultFolders: readonly string[],
): Promise<void> {
  let companyId = user.companyId ?? null;
  if (!companyId) {
    companyId = await repo.findCompanyIdByContactEmail(user.email);
    if (companyId) await repo.setUserCompanyId(user.id, companyId);
  }
  if (!companyId) return;
  await repo.linkUserCompany(user.id, companyId);
  if (!(await repo.companyHasFolders(companyId))) {
    await repo.createDefaultFolders(companyId, user.id, defaultFolders);
  }
}

export interface BetterAuthRouterDeps {
  auth: BetterAuth;
  repo: AuthRepository;
  config: AuthConfig;
}

/**
 * The `/api/auth` HTTP surface, served by Better Auth but preserving the legacy
 * JSON contract so the SPA is unaffected (ADR-0007). Sessions are established as
 * httpOnly cookies (M2/M3) and are revocable server-side (M1). helmet + pino are
 * scoped here so the gateway's legacy pass-through stays byte-identical.
 */
export function createBetterAuthRouter(deps: BetterAuthRouterDeps): Router {
  const { auth, repo, config } = deps;
  const router = express.Router();
  router.use(helmet());
  router.use(pinoHttp());
  router.use(express.json());

  // H1 — rate-limit failed logins per IP+email. Successful logins don't count.
  const loginLimiter = rateLimit({
    windowMs: config.loginRateLimit.windowMs,
    max: config.loginRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req: Request) => {
      const email = (req.body as { email?: string } | undefined)?.email ?? "";
      return `${req.ip ?? "unknown"}:${String(email).toLowerCase()}`;
    },
    handler: (_req, res) =>
      res.status(429).json({ error: "Too many attempts. Please try again later." }),
  });

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch(next);

  router.post(
    "/login",
    loginLimiter,
    handle(async (req, res) => {
      const parsed = contracts.loginRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      try {
        const { headers, response } = await auth.api.signInEmail({
          body: { email: parsed.data.email, password: parsed.data.password },
          returnHeaders: true,
        });
        forwardSetCookie(headers, res);
        const user = (response as { user: BetterAuthUser }).user;
        if ((user.role ?? "buyer") === "buyer") {
          await provisionClient(repo, user, config.defaultFolders);
        }
        const companyIds = await repo.listCompanyIdsForUser(user.id);
        // A bearer token (bearer plugin) is returned for non-cookie API clients.
        const token = headers.get("set-auth-token") ?? (response as { token?: string }).token ?? "";
        res.json({ token, user: toSessionUser(user, companyIds) });
      } catch {
        // Enumeration-safe: any failure is a generic 401.
        res.status(401).json({ error: "Invalid credentials" });
      }
    }),
  );

  router.get(
    "/me",
    requireBetterAuth(auth, repo),
    handle(async (req, res) => {
      res.json({ user: req.user });
    }),
  );

  router.post(
    "/logout",
    handle(async (req, res) => {
      try {
        const { headers } = await auth.api.signOut({
          headers: fromNodeHeaders(req.headers),
          returnHeaders: true,
        });
        forwardSetCookie(headers, res);
      } catch {
        /* already logged out — still clear client state */
      }
      res.status(204).send();
    }),
  );

  router.post(
    "/forgot-password",
    handle(async (req, res) => {
      const parsed = contracts.forgotPasswordRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      // Enumeration-safe: dispatch only for real accounts; always respond generically.
      try {
        await auth.api.requestPasswordResetEmailOTP({ body: { email: parsed.data.email } });
      } catch {
        /* swallow — response stays generic */
      }
      res.json({ success: true, message: GENERIC_RESET });
    }),
  );

  router.post(
    "/reset-password",
    handle(async (req, res) => {
      const parsed = contracts.resetPasswordRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      try {
        await auth.api.resetPasswordEmailOTP({
          body: {
            email: parsed.data.email,
            otp: parsed.data.otp,
            password: parsed.data.new_password,
          },
        });
        res.json({ success: true, message: "Your password has been reset. You can now sign in." });
      } catch (err) {
        const { status, message } = errorStatus(err);
        res.status(status).json({ error: message });
      }
    }),
  );

  router.post(
    "/send-otp",
    handle(async (req, res) => {
      const parsed = contracts.otpSendRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      await auth.api.sendVerificationOTP({
        body: { email: parsed.data.email, type: "email-verification" },
      });
      res.json({ success: true });
    }),
  );

  router.post(
    "/verify-otp",
    handle(async (req, res) => {
      const parsed = contracts.otpVerifyRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      try {
        await auth.api.verifyEmailOTP({
          body: { email: parsed.data.email, otp: parsed.data.otp },
        });
        res.json({ verified: true });
      } catch (err) {
        const { status, message } = errorStatus(err);
        res.status(status).json({ error: message });
      }
    }),
  );

  return router;
}

export { resolveSessionUser };
