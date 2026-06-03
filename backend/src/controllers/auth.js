const jwt = require("jsonwebtoken");
const asyncHandler = require("../utils");
const { authenticate, createBrokerAccount } = require("../services/authService");
const userService = require("../services/userService");
const otpService = require("../services/otpService");
const { sendOtpEmail } = require("../services/emailService");

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
    decodedToken = jwt.verify(verification_token, process.env.JWT_SECRET || "change_me");
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

module.exports = {
  login,
  signupBroker,
  logout,
  me,
  sendVerificationOtp,
  verifyVerificationOtp,
};
