const jwt = require("jsonwebtoken");
const asyncHandler = require("../utils");
const { authenticate, createBrokerAccount } = require("../services/authService");
const userService = require("../services/userService");
const otpService = require("../services/otpService");
const { sendOtpEmail } = require("../services/emailService");
const { JWT_SECRET } = require("../config/secrets");
const { invalidateUserCache } = require("../middleware/auth");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Existing handlers (unchanged) ────────────────────────────────────────────

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  try {
    const { user, token } = await authenticate(email, password);
    return res.json({ token, user });
  } catch (error) {
    if (error.message === "Invalid credentials") {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    throw error;
  }
});

/**
 * POST /auth/broker/signup
 * Now requires a valid verification_token (issued by /auth/verify-verification-otp)
 * to confirm the email address was verified before creating the account.
 */
const signupBroker = asyncHandler(async (req, res) => {
  const { password, confirm_password, confirmPassword, verification_token } =
    req.body || {};
  const confirm = confirm_password ?? confirmPassword;

  if (confirm !== undefined && String(password || "") !== String(confirm || "")) {
    return res.status(400).json({ error: "Passwords do not match." });
  }

  // ── Require email verification ──────────────────────────────────────────
  if (!verification_token) {
    return res.status(403).json({
      error: "Email verification required. Please verify your email address first.",
    });
  }

  let decodedToken;
  try {
    decodedToken = jwt.verify(verification_token, JWT_SECRET);
  } catch {
    return res.status(403).json({
      error: "Verification token is expired or invalid. Please verify your email again.",
    });
  }

  if (decodedToken.purpose !== "email_verification") {
    return res.status(403).json({ error: "Invalid verification token." });
  }

  const tokenEmail = String(decodedToken.email || "").toLowerCase();
  const bodyEmail  = String(req.body?.email || "").trim().toLowerCase();
  if (!tokenEmail || tokenEmail !== bodyEmail) {
    return res.status(403).json({
      error: "Verification token does not match the submitted email address.",
    });
  }

  console.log(
    `[Audit] [Broker Signup] Verified token accepted for <${bodyEmail}> at ${new Date().toISOString()}`
  );

  try {
    const { user, token } = await createBrokerAccount(req.body);
    return res.status(201).json({ token, user });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
});

const logout = asyncHandler(async (req, res) => {
  return res.status(204).send();
});

const me = asyncHandler(async (req, res) => {
  const fresh = await userService.getUserById(req.user.id);
  return res.json({ user: fresh || req.user });
});

// ── New OTP endpoints ─────────────────────────────────────────────────────────

/**
 * POST /auth/send-verification-otp
 * Body: { email }
 * Generates a 6-digit OTP, stores its hash in email_verifications, sends the
 * plain OTP to the user's email. Rate-limited: max 3 requests per 10 minutes.
 */
const sendVerificationOtp = asyncHandler(async (req, res) => {
  const { email } = req.body || {};

  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: "A valid email address is required." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  // Block if an account already exists with this email
  const existing = await userService.getUserByEmail(normalizedEmail);
  if (existing) {
    return res.status(409).json({
      error: "An account with this email already exists. Please sign in instead.",
    });
  }

  const otp = await otpService.sendOtp(normalizedEmail);

  const emailResult = await sendOtpEmail(normalizedEmail, otp);
  if (!emailResult.sent) {
    console.warn(
      `[Audit] [OTP] Email delivery failed for <${normalizedEmail}>: ` +
        `${emailResult.reason} ${emailResult.error || ""}`
    );
    // Still return success — otp exists in store; frontend should warn user to check spam
    // In development without SMTP configured, log the OTP so testing is possible
    if (process.env.NODE_ENV !== "production") {
      console.log(`[OTP Service][DEV ONLY] OTP for <${normalizedEmail}>: ${otp}`);
    }
  } else {
    console.log(
      `[Audit] [OTP] Verification email sent to <${normalizedEmail}> at ${new Date().toISOString()}`
    );
  }

  return res.json({ success: true, emailSent: emailResult.sent });
});

/**
 * POST /auth/verify-verification-otp
 * Body: { email, otp }
 * Validates the OTP. On success returns a 15-minute verificationToken JWT that
 * must be included in the subsequent POST /auth/broker/signup call.
 */
const verifyVerificationOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body || {};

  if (!email || !otp) {
    return res.status(400).json({ error: "Email and verification code are required." });
  }

  const result = await otpService.verifyOtp(
    String(email).trim().toLowerCase(),
    String(otp).trim()
  );

  console.log(
    `[Audit] [OTP] Email <${String(email).trim()}> verified at ${new Date().toISOString()}`
  );

  return res.json({
    verified: true,
    verificationToken: result.verificationToken,
  });
});

// ── Password reset flow ───────────────────────────────────────────────────────

function validatePasswordStrength(password) {
  const pw = String(password || "");
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    return "Password must include at least one letter and one number.";
  }
  return null;
}

/**
 * POST /auth/forgot-password
 * Body: { email }
 * Sends a 6-digit reset code to the email IF an account exists. Always returns
 * a generic success response so the endpoint cannot be used to enumerate which
 * email addresses have accounts. Rate-limiting is enforced by otpService.
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body || {};

  const genericResponse = {
    success: true,
    message: "If an account exists for that email, a reset code has been sent.",
  };

  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: "A valid email address is required." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const user = await userService.getUserByEmail(normalizedEmail);
    // Only send a code to real, non-inactive accounts — but never reveal which.
    if (user && String(user.status || "").toLowerCase() !== "inactive") {
      const otp = await otpService.sendOtp(normalizedEmail);
      const emailResult = await sendOtpEmail(normalizedEmail, otp);
      if (!emailResult.sent) {
        console.warn(
          `[Audit] [Reset] Email delivery failed for <${normalizedEmail}>: ` +
            `${emailResult.reason} ${emailResult.error || ""}`
        );
      } else {
        console.log(
          `[Audit] [Reset] Reset code sent to <${normalizedEmail}> at ${new Date().toISOString()}`
        );
      }
    } else {
      console.log(`[Audit] [Reset] Reset requested for non-account <${normalizedEmail}> (no code sent)`);
    }
  } catch (err) {
    // Includes otpService rate-limit (429). Swallow so the response stays generic
    // and non-enumerable; the rate limit itself is still enforced internally.
    console.warn(`[Audit] [Reset] forgot-password suppressed error for <${normalizedEmail}>: ${err.message}`);
  }

  return res.json(genericResponse);
});

/**
 * POST /auth/reset-password
 * Body: { email, otp, new_password }
 * Verifies the reset code and sets a new bcrypt-hashed password on the account.
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { email, otp } = req.body || {};
  const newPassword = req.body?.new_password ?? req.body?.newPassword ?? req.body?.password;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: "Email, reset code, and new password are required." });
  }

  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) {
    return res.status(400).json({ error: strengthError });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  // Verify the OTP first. Throws (400/429) on invalid/expired/too-many-attempts.
  await otpService.verifyOtp(normalizedEmail, String(otp).trim());

  const user = await userService.getUserByEmail(normalizedEmail);
  if (!user) {
    // OTPs are only issued to real accounts, so this is effectively unreachable;
    // return a generic error rather than confirming account (non-)existence.
    return res.status(400).json({ error: "Unable to reset password. Please request a new code." });
  }

  await userService.updateUser(user.id, { password: String(newPassword) });
  invalidateUserCache(user.id);

  console.log(
    `[Audit] [Reset] Password reset completed for <${normalizedEmail}> at ${new Date().toISOString()}`
  );

  return res.json({ success: true, message: "Your password has been reset. You can now sign in." });
});

module.exports = {
  login,
  signupBroker,
  logout,
  me,
  sendVerificationOtp,
  verifyVerificationOtp,
  forgotPassword,
  resetPassword,
};
