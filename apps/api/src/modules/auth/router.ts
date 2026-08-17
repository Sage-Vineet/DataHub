import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { auth as contracts } from "@datahub/contracts";
import { withCommonMiddleware } from "../../shared/router.js";
import type { AuthConfig } from "./config.js";
import { AuthError } from "./errors.js";
import { requireAuth } from "./middleware.js";
import type { AuthService } from "./service.js";

const GENERIC_RESET = "If an account exists for that email, a reset code has been sent.";

/** Structural, zod-version-agnostic — reads the first validation message. */
function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

/** Wrap an async handler so thrown AuthErrors become their HTTP status. */
function handle(fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch((err: unknown) => {
      if (err instanceof AuthError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    });
  };
}

/**
 * The auth HTTP surface. helmet + pino-http are scoped HERE (not globally) so
 * the gateway's legacy pass-through stays byte-identical (design D6). The chain is
 * attached per-route (not via `router.use`) so sibling paths under the mount fall
 * through to legacy untouched — see `withCommonMiddleware`.
 */
export function createAuthRouter(service: AuthService, config: AuthConfig): Router {
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

  router.post(
    "/login",
    loginLimiter,
    handle(async (req, res) => {
      const parsed = contracts.loginRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      const { user, token } = await service.authenticate(parsed.data.email, parsed.data.password);
      res.json({ token, user });
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
      await service.forgotPassword(parsed.data.email);
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
      await service.resetPassword(parsed.data.email, parsed.data.otp, parsed.data.new_password);
      res.json({ success: true, message: "Your password has been reset. You can now sign in." });
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
      await service.sendOtp(parsed.data.email);
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
      const result = await service.verifyOtp(parsed.data.email, parsed.data.otp);
      res.json(result);
    }),
  );

  router.get(
    "/me",
    requireAuth(service),
    handle((req, res) => {
      res.json({ user: req.user });
    }),
  );

  router.post("/logout", (_req, res) => {
    res.status(204).send();
  });

  return router;
}
