"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");

const controller = require("../controllers/auth");
const { requireAuth } = require("../middleware/auth");
const { authLimiter, sensitiveLimiter } = require("../middleware/rateLimit");
const { validate, schemas, z } = require("../middleware/validate");

const router = express.Router();

// Refresh tokens travel as an HttpOnly cookie scoped to /auth.
router.use(cookieParser());

// ── Validation schemas ───────────────────────────────────────────────────────
// `.strict()` rejects unexpected keys outright, which closes mass assignment:
// a signup POST carrying `"role": "admin"` or `"status": "active"` is refused
// rather than silently forwarded to an insert.

const loginSchema = schemas.strictObject({
  email: schemas.email,
  // Length only — content rules belong on the *setting* of a password, not the
  // checking of one. Rejecting a long password here would leak policy details
  // and break accounts whose password predates the current rules.
  password: z.string().min(1).max(200),
});

const signupSchema = schemas.strictObject({
  name: schemas.text(120, { min: 2 }),
  email: schemas.email,
  phone: schemas.phone,
  password: z.string().min(1).max(200),
  confirm_password: z.string().min(1).max(200).optional(),
  confirmPassword: z.string().min(1).max(200).optional(),
  broker_company: schemas.text(160).optional(),
  brokerCompany: schemas.text(160).optional(),
  verification_token: z.string().min(10).max(4096),
});

const emailOnlySchema = schemas.strictObject({ email: schemas.email });

const otpSchema = schemas.strictObject({
  email: schemas.email,
  // Exactly six digits — anything else is rejected before it reaches bcrypt.
  otp: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
});

const resetSchema = schemas.strictObject({
  email: schemas.email,
  new_password: z.string().min(1).max(200).optional(),
  newPassword: z.string().min(1).max(200).optional(),
  verification_token: z.string().min(10).max(4096),
});

const changePasswordSchema = schemas.strictObject({
  current_password: z.string().min(1).max(200).optional(),
  currentPassword: z.string().min(1).max(200).optional(),
  new_password: z.string().min(1).max(200).optional(),
  newPassword: z.string().min(1).max(200).optional(),
});

const refreshSchema = z
  .object({
    refresh_token: z.string().min(10).max(4096).optional(),
    refreshToken: z.string().min(10).max(4096).optional(),
  })
  .strict();

// ── Public endpoints ─────────────────────────────────────────────────────────
// Every one is rate limited. `authLimiter` is keyed by IP and skips successful
// requests, so normal use is never throttled while brute force is.

router.post("/login", authLimiter, validate({ body: loginSchema }), controller.login);

router.post("/refresh", authLimiter, validate({ body: refreshSchema }), controller.refresh);

router.post(
  "/broker/signup",
  authLimiter,
  validate({ body: signupSchema }),
  controller.signupBroker
);

router.get("/password-policy", controller.passwordPolicy);

// `sensitiveLimiter` (5/hour) applies to anything that sends email — these are
// abusable both as a spam relay and as a way to burn the sending reputation.
router.post(
  "/send-verification-otp",
  sensitiveLimiter,
  validate({ body: emailOnlySchema }),
  controller.sendVerificationOtp
);

router.post(
  "/verify-verification-otp",
  authLimiter,
  validate({ body: otpSchema }),
  controller.verifyVerificationOtp
);

router.post(
  "/forgot-password",
  sensitiveLimiter,
  validate({ body: emailOnlySchema }),
  controller.forgotPassword
);

router.post(
  "/verify-reset-otp",
  authLimiter,
  validate({ body: otpSchema }),
  controller.verifyResetOtp
);

router.post(
  "/reset-password",
  authLimiter,
  validate({ body: resetSchema }),
  controller.resetPassword
);

// ── Authenticated endpoints ──────────────────────────────────────────────────

router.get("/me", requireAuth, controller.me);
router.get("/sessions", requireAuth, controller.listSessions);
router.post("/logout", requireAuth, controller.logout);
router.post("/logout-all", requireAuth, controller.logoutAll);

router.post(
  "/change-password",
  requireAuth,
  authLimiter,
  validate({ body: changePasswordSchema }),
  controller.changeOwnPassword
);

module.exports = router;
