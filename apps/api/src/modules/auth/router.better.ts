import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { fromNodeHeaders } from "better-auth/node";
import { auth as contracts } from "@datahub/contracts";
import { emitActivity } from "../../activity/capture.js";
import { withCommonMiddleware } from "../../shared/router.js";
import { issueVerificationGrant, verifyVerificationGrant } from "./verification-grant.js";
import type { AuthConfig } from "./config.js";
import type { BetterAuth } from "./better-auth.js";
import type { AuthRepository } from "./ports.js";
import { type BetterAuthUser, requireBetterAuth, resolveSessionUser, toSessionUser } from "./better-session.js";

const GENERIC_RESET = "If an account exists for that email, a reset code has been sent.";

/** Structural, zod-version-agnostic — reads the first validation message. */
export function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

/**
 * Better Auth throws APIError with a numeric status + message; normalise it.
 *
 * The status lives under `statusCode` on some throws and `status` on others,
 * and neither is guaranteed — an error from the transport rather than the
 * library has neither. 400 is the fallback because a caller seeing 500 goes
 * looking for a fault in the server, and the common case here is a request
 * the library refused.
 */
export function errorStatus(err: unknown): { status: number; message: string } {
  const e = err as { statusCode?: number; status?: number; body?: { message?: string }; message?: string };
  const status = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : 400;
  return { status, message: e.body?.message ?? e.message ?? "Request failed." };
}

/** Copy Better Auth's Set-Cookie (session cookie set/clear) onto the Express response. */
export function forwardSetCookie(headers: Headers, res: Response): void {
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

/**
 * Registration OTPs, which are not the same thing as Better Auth's.
 *
 * Better Auth's `sendVerificationOTP` verifies the address of an account that
 * already exists; for an address with no account it returns success and sends
 * nothing at all. Signup is precisely the case where no account exists yet, so
 * it uses the module's own OTP store — the one the bespoke `AuthService`
 * already implements, with its resend and attempt limits.
 */
export interface SignupOtpPort {
  sendOtp(email: string): Promise<void>;
  /** Throws `AuthError` when the code is wrong, stale or over its attempt cap. */
  verifyOtp(email: string, otp: string): Promise<unknown>;
}

export interface BetterAuthRouterDeps {
  auth: BetterAuth;
  repo: AuthRepository;
  config: AuthConfig;
  signupOtp: SignupOtpPort;
}

/**
 * The `/auth` HTTP surface, served by Better Auth but preserving the legacy JSON
 * contract so the SPA is unaffected (ADR-0007). Sessions are established as
 * httpOnly cookies (M2/M3) and are revocable server-side (M1). helmet + pino are
 * scoped here so the gateway's legacy pass-through stays byte-identical.
 *
 * The chain is attached per-route (not via `router.use`) so sibling paths under the
 * mount fall through to legacy untouched — see `withCommonMiddleware`.
 */
export function createBetterAuthRouter(deps: BetterAuthRouterDeps): Router {
  const { auth, repo, config, signupOtp } = deps;
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json()]);

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
          // Deliberately not allowed to fail the login. The credential was
          // valid; provisioning is what happens next. Inside the catch below it
          // reported a correct password as "Invalid credentials", which sends
          // the client to reset a password that was never wrong.
          //
          // A client with no companies is already a valid outcome — an account
          // waiting to be associated — so a provisioning failure lands them in
          // the same place, signed in with nothing yet attached.
          try {
            await provisionClient(repo, user, config.defaultFolders);
          } catch (err) {
            console.error(
              `[auth] client provisioning failed for ${user.id}; signing in anyway: ${String(err)}`,
            );
          }
        }
        const companyIds = await repo.listCompanyIdsForUser(user.id);
        // A bearer token (bearer plugin) is returned for non-cookie API clients.
        const token = headers.get("set-auth-token") ?? (response as { token?: string }).token ?? "";
        // Tier 2 carries the session-validated identity; tier 1 cannot attribute a
        // Better Auth login, because the credential is only valid after this call.
        emitActivity(res, { event_type: "auth.login.succeeded", actor_id: user.id });
        res.json({ token, user: toSessionUser(user, companyIds) });
      } catch {
        // The response stays enumeration-safe; the log records the attempt, which
        // is what SE-0004 asks for and what brute-force review needs.
        emitActivity(res, {
          event_type: "auth.login.failed",
          payload: { email: parsed.data.email },
        });
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
      emitActivity(res, { event_type: "auth.session.terminated" });
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
        emitActivity(res, {
          event_type: "auth.password.changed",
          payload: { email: parsed.data.email },
        });
        res.json({ success: true, message: "Your password has been reset. You can now sign in." });
      } catch (err) {
        const { status, message } = errorStatus(err);
        res.status(status).json({ error: message });
      }
    }),
  );

  // Two spellings: `/send-verification-otp` is what the SPA calls (and what
  // legacy served); `/send-otp` predates it in this module. Both are registered
  // rather than one redirecting, because a 307 on a POST is a trap.
  for (const path of ["/send-otp", "/send-verification-otp"]) router.post(
    path,
    handle(async (req, res) => {
      const parsed = contracts.otpSendRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      try {
        await signupOtp.sendOtp(parsed.data.email);
      } catch (err) {
        const { status, message } = errorStatus(err);
        res.status(status).json({ error: message });
        return;
      }
      // Always the same answer, whether or not an account exists: the response
      // must not tell a stranger which addresses are registered.
      res.json({ success: true });
    }),
  );

  for (const path of ["/verify-otp", "/verify-verification-otp"]) router.post(
    path,
    handle(async (req, res) => {
      const parsed = contracts.otpVerifyRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      try {
        await signupOtp.verifyOtp(parsed.data.email, parsed.data.otp);
        // The grant is what lets `/broker/signup` know this happened. Without
        // it, signup is a second, unauthenticated request that would let anyone
        // register any address.
        res.json({
          verified: true,
          verificationToken: issueVerificationGrant(
            parsed.data.email,
            config.jwtSecret,
            Date.now(),
          ),
        });
      } catch (err) {
        const { status, message } = errorStatus(err);
        res.status(status).json({ error: message });
      }
    }),
  );

  router.post(
    "/broker/signup",
    handle(async (req, res) => {
      const parsed = contracts.brokerSignupRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      const input = parsed.data;

      const grant = verifyVerificationGrant(
        input.verification_token,
        input.email,
        config.jwtSecret,
        Date.now(),
      );
      if (!grant.ok) {
        // One message for every failure mode. Telling the caller whether a grant
        // was expired, forged or issued for a different address is an oracle,
        // and the remedy is the same in all three cases.
        emitActivity(res, {
          event_type: "auth.signup.rejected",
          payload: { email: input.email, reason: grant.reason },
        });
        res.status(403).json({
          error: "Email verification required. Please verify your email address again.",
        });
        return;
      }

      if (await repo.findUserByEmail(input.email)) {
        res.status(409).json({ error: "An account with this email already exists." });
        return;
      }

      let created: { headers: Headers; response: unknown };
      try {
        created = await auth.api.signUpEmail({
          body: { email: input.email, password: input.password, name: input.name },
          returnHeaders: true,
        });
      } catch (err) {
        const { status, message } = errorStatus(err);
        res.status(status === 401 ? 409 : status).json({ error: message });
        return;
      }

      const user = (created.response as { user: BetterAuthUser }).user;
      await repo.createBrokerUser({
        id: user.id,
        name: input.name,
        email: input.email,
        phone: input.phone,
        brokerCompany: input.broker_company ?? input.brokerCompany ?? null,
      });

      forwardSetCookie(created.headers, res);
      const token =
        created.headers.get("set-auth-token") ?? (created.response as { token?: string }).token ?? "";
      emitActivity(res, { event_type: "auth.signup.succeeded", actor_id: user.id });

      // Re-read so the response carries the broker role just written, rather
      // than the buyer default Better Auth created the row with.
      const fresh = (await repo.findUserById(user.id)) ?? null;
      res.status(201).json({
        token,
        user: toSessionUser({ ...user, role: fresh?.role ?? "broker", name: input.name }, []),
      });
    }),
  );

  return router;
}

export { resolveSessionUser };
