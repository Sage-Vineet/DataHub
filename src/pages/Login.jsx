import { useState, useRef, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import {
  Eye, EyeOff, LogIn, UserPlus, X,
  ShieldCheck, RotateCcw, ArrowLeft, Mail, KeyRound,
} from "lucide-react";
import datahublogo from "../assets/datahublogo.png";
import {
  sendVerificationOtpRequest, verifyVerificationOtpRequest,
  forgotPasswordRequest, verifyResetOtpRequest,
} from "../lib/api";

// ── Constants ─────────────────────────────────────────────────────────────────

const LOGIN_FORM = { email: "", password: "" };

const SIGNUP_FORM = {
  firstName: "",
  lastName: "",
  broker_company: "",
  email: "",
  phone: "",
  password: "",
  confirmPassword: "",
};

const TERMS_TEXT = `Terms of Service & Privacy Policy

Last updated: January 1, 2026

1. ACCEPTANCE OF TERMS
By accessing or using M&A Hub ("the Platform"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the Platform.

2. USE OF THE PLATFORM
M&A Hub provides a secure data room and document management platform for mergers and acquisitions professionals. You agree to use the Platform only for lawful purposes and in accordance with these Terms.

3. ACCOUNT REGISTRATION
You must provide accurate and complete information when creating an account. You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account.

4. DATA & PRIVACY
We collect and process personal information in accordance with our Privacy Policy. We implement industry-standard security measures to protect your data. By using the Platform, you consent to the collection and use of your information as described in our Privacy Policy.

5. CONFIDENTIALITY
All information shared through the Platform is confidential. You agree not to disclose, distribute, or use any information obtained through the Platform for any purpose other than the intended transaction.

6. INTELLECTUAL PROPERTY
All content, features, and functionality of the Platform are owned by M&A Hub and are protected by applicable intellectual property laws.

7. LIMITATION OF LIABILITY
M&A Hub shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use of or inability to use the Platform.

8. TERMINATION
We reserve the right to suspend or terminate your account at any time for violation of these Terms or for any other reason at our sole discretion.

9. CHANGES TO TERMS
We reserve the right to modify these Terms at any time. Continued use of the Platform after changes constitutes acceptance of the new Terms.

10. CONTACT
For questions about these Terms, please contact us at legal@mahub.com.

This is placeholder text. Actual terms will be provided by legal counsel.`;

// ── Utility functions ─────────────────────────────────────────────────────────

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function formatUSPhone(raw) {
  const d = raw.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function generateCaptcha() {
  const a = Math.floor(Math.random() * 12) + 1;
  const b = Math.floor(Math.random() * 12) + 1;
  const add = Math.random() > 0.4;
  if (add) return { question: `${a} + ${b}`, answer: a + b };
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return { question: `${hi} − ${lo}`, answer: hi - lo };
}

function passwordStrengthError(pw) {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw))
    return "Password must include at least one letter and one number.";
  return "";
}

function maskEmail(email) {
  const at = (email || "").indexOf("@");
  if (at <= 0) return email;
  const user = email.slice(0, at);
  const domain = email.slice(at);
  return user.slice(0, Math.min(2, user.length)) + "***" + domain;
}

// ── Terms modal ───────────────────────────────────────────────────────────────

function TermsModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[#E8EDF5] px-6 py-4">
          <h3 className="text-base font-bold text-[#050505]">
            Terms of Service &amp; Privacy Policy
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[#6D6E71] transition-colors hover:bg-[#F4F6FA] hover:text-[#050505]"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-[#6D6E71]">
            {TERMS_TEXT}
          </pre>
        </div>
        <div className="border-t border-[#E8EDF5] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-xl bg-[#05164D] py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#0a2272]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Login() {
  // Mode: "login" | "signup" | "reset"
  const [mode, setMode] = useState("login");
  // Signup sub-step: "form" | "verify"
  const [step, setStep] = useState("form");
  // Reset-password sub-step: "request" | "otp" | "newPassword"
  const [resetStep, setResetStep] = useState("request");

  const [loginForm, setLoginForm]     = useState(LOGIN_FORM);
  const [signupForm, setSignupForm]   = useState(SIGNUP_FORM);
  const [pendingForm, setPendingForm] = useState(null); // preserved during OTP step

  const [showPass, setShowPass]             = useState(false);
  const [showSignupPass, setShowSignupPass] = useState(false);
  const [loading, setLoading]               = useState(false);

  // Registration extras
  const [termsAccepted, setTermsAccepted]   = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [captcha]                           = useState(generateCaptcha);
  const [captchaInput, setCaptchaInput]     = useState("");

  // OTP step (shared by signup verification and password reset — only one flow is ever active)
  const [otpDigits, setOtpDigits]         = useState(["", "", "", "", "", ""]);
  const [otpError, setOtpError]           = useState("");
  const [otpLoading, setOtpLoading]       = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [countdown, setCountdown]         = useState(0);
  const otpRefs = useRef([]);

  // Reset-password flow
  const [resetEmail, setResetEmail]               = useState("");
  const [pendingResetEmail, setPendingResetEmail] = useState("");
  const [resetToken, setResetToken]               = useState("");
  const [newPassword, setNewPassword]             = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [showNewPass, setShowNewPass]             = useState(false);
  const [resetLoading, setResetLoading]           = useState(false);

  const { login, signupBroker, resetPassword, error, setError } = useAuth();

  // Countdown ticker for resend button
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // ── Mode switching ──────────────────────────────────────────────────────────
  const switchMode = (next) => {
    setMode(next);
    setStep("form");
    setResetStep("request");
    setError("");
    setOtpDigits(["", "", "", "", "", ""]);
    setOtpError("");
    setShowPass(false);
    setShowSignupPass(false);
    setShowNewPass(false);
    setTermsAccepted(false);
    setCaptchaInput("");
    setResetEmail("");
    setPendingResetEmail("");
    setResetToken("");
    setNewPassword("");
    setConfirmNewPassword("");
  };

  const setLoginField  = (f, v) => { setLoginForm((c) => ({ ...c, [f]: v })); if (error) setError(""); };
  const setSignupField = (f, v) => { setSignupForm((c) => ({ ...c, [f]: v })); if (error) setError(""); };
  const handlePhoneChange = (raw) => setSignupField("phone", formatUSPhone(raw));

  // ── Validation ──────────────────────────────────────────────────────────────
  const validateSignup = () => {
    const firstName = signupForm.firstName.trim();
    const lastName  = signupForm.lastName.trim();
    const email     = signupForm.email.trim().toLowerCase();
    const pw        = signupForm.password;
    if (!firstName)                         return "First name is required.";
    if (!lastName)                          return "Last name is required.";
    if (!email || !isValidEmail(email))     return "Please enter a valid email address.";
    const pwError = passwordStrengthError(pw);
    if (pwError)                             return pwError;
    if (pw !== signupForm.confirmPassword)  return "Passwords do not match.";
    if (parseInt(captchaInput, 10) !== captcha.answer)
      return "Captcha answer is incorrect.";
    if (!termsAccepted)
      return "You must agree to the Terms of Service to continue.";
    return "";
  };

  // ── Login ───────────────────────────────────────────────────────────────────
  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try { await login(loginForm.email, loginForm.password); }
    finally { setLoading(false); }
  };

  // ── Step 1: validate → send OTP → show verify screen ───────────────────────
  const handleSignupSubmit = async (e) => {
    e.preventDefault();
    const err = validateSignup();
    if (err) { setError(err); return; }

    setLoading(true);
    setError("");
    try {
      await sendVerificationOtpRequest({ email: signupForm.email.trim().toLowerCase() });
      setPendingForm({ ...signupForm });
      setOtpDigits(["", "", "", "", "", ""]);
      setOtpError("");
      setStep("verify");
      setCountdown(60);
      setTimeout(() => otpRefs.current[0]?.focus(), 50);
    } catch (err) {
      setError(err.message || "Failed to send verification code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // ── OTP input ───────────────────────────────────────────────────────────────
  const handleOtpChange = (i, value) => {
    if (!/^\d*$/.test(value)) return;
    const next = [...otpDigits];
    next[i] = value.slice(-1);
    setOtpDigits(next);
    setOtpError("");
    if (value && i < 5) otpRefs.current[i + 1]?.focus();
  };

  const handleOtpKeyDown = (i, e) => {
    if (e.key === "Backspace" && !otpDigits[i] && i > 0) {
      otpRefs.current[i - 1]?.focus();
    }
  };

  const handleOtpPaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!pasted) return;
    const next = ["", "", "", "", "", ""];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setOtpDigits(next);
    otpRefs.current[Math.min(pasted.length, 5)]?.focus();
  };

  // ── Step 2: verify OTP → create broker account ──────────────────────────────
  const handleVerifyOtp = async () => {
    const otp = otpDigits.join("");
    if (otp.length !== 6) { setOtpError("Please enter the complete 6-digit code."); return; }
    setOtpLoading(true);
    setOtpError("");
    try {
      const result = await verifyVerificationOtpRequest({
        email: pendingForm.email.trim().toLowerCase(),
        otp,
      });
      const fullName =
        `${(pendingForm.firstName || "").trim()} ${(pendingForm.lastName || "").trim()}`.trim();
      await signupBroker({
        name:               fullName,
        broker_company:     pendingForm.broker_company.trim(),
        email:              pendingForm.email.trim().toLowerCase(),
        phone:              pendingForm.phone.trim(),
        password:           pendingForm.password,
        confirmPassword:    pendingForm.confirmPassword,
        verification_token: result.verificationToken,
      });
    } catch (err) {
      setOtpError(err.message || "Verification failed. Please try again.");
    } finally {
      setOtpLoading(false);
    }
  };

  // ── Resend OTP ──────────────────────────────────────────────────────────────
  const handleResendOtp = async () => {
    setResendLoading(true);
    setOtpError("");
    try {
      await sendVerificationOtpRequest({ email: pendingForm.email.trim().toLowerCase() });
      setOtpDigits(["", "", "", "", "", ""]);
      setCountdown(60);
      setTimeout(() => otpRefs.current[0]?.focus(), 50);
    } catch (err) {
      setOtpError(err.message || "Failed to resend code.");
    } finally {
      setResendLoading(false);
    }
  };

  const handleBackToForm = () => {
    setStep("form");
    setOtpDigits(["", "", "", "", "", ""]);
    setOtpError("");
    setError("");
    if (pendingForm) setSignupForm(pendingForm);
  };

  // ── Forgot password: request OTP ─────────────────────────────────────────────
  const handleForgotPasswordSubmit = async (e) => {
    e.preventDefault();
    const emailTrimmed = resetEmail.trim().toLowerCase();
    if (!isValidEmail(emailTrimmed)) { setError("Please enter a valid email address."); return; }

    setResetLoading(true);
    setError("");
    try {
      await forgotPasswordRequest({ email: emailTrimmed });
      setPendingResetEmail(emailTrimmed);
      setOtpDigits(["", "", "", "", "", ""]);
      setOtpError("");
      setResetStep("otp");
      setCountdown(60);
      setTimeout(() => otpRefs.current[0]?.focus(), 50);
    } catch (err) {
      setError(err.message || "Failed to send reset code. Please try again.");
    } finally {
      setResetLoading(false);
    }
  };

  // ── Forgot password: verify OTP ──────────────────────────────────────────────
  const handleVerifyResetOtp = async () => {
    const otp = otpDigits.join("");
    if (otp.length !== 6) { setOtpError("Please enter the complete 6-digit code."); return; }
    setOtpLoading(true);
    setOtpError("");
    try {
      const result = await verifyResetOtpRequest({ email: pendingResetEmail, otp });
      setResetToken(result.verificationToken);
      setNewPassword("");
      setConfirmNewPassword("");
      setResetStep("newPassword");
    } catch (err) {
      setOtpError(err.message || "Verification failed. Please try again.");
    } finally {
      setOtpLoading(false);
    }
  };

  // ── Forgot password: resend OTP ──────────────────────────────────────────────
  const handleResendResetOtp = async () => {
    setResendLoading(true);
    setOtpError("");
    try {
      await forgotPasswordRequest({ email: pendingResetEmail });
      setOtpDigits(["", "", "", "", "", ""]);
      setCountdown(60);
      setTimeout(() => otpRefs.current[0]?.focus(), 50);
    } catch (err) {
      setOtpError(err.message || "Failed to resend code.");
    } finally {
      setResendLoading(false);
    }
  };

  // ── Forgot password: set new password → auto sign-in ────────────────────────
  const handleResetPasswordSubmit = async (e) => {
    e.preventDefault();
    const pwError = passwordStrengthError(newPassword);
    if (pwError) { setError(pwError); return; }
    if (newPassword !== confirmNewPassword) { setError("Passwords do not match."); return; }

    setResetLoading(true);
    setError("");
    try {
      await resetPassword({
        email: pendingResetEmail,
        new_password: newPassword,
        verification_token: resetToken,
      });
    } finally {
      setResetLoading(false);
    }
  };

  const handleBackToResetRequest = () => {
    setResetStep("request");
    setOtpDigits(["", "", "", "", "", ""]);
    setOtpError("");
    setError("");
  };

  const isSignup  = mode === "signup";
  const isReset   = mode === "reset";
  const otpFilled = otpDigits.join("").length === 6;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      {showTermsModal && <TermsModal onClose={() => setShowTermsModal(false)} />}

      <div className="relative min-h-screen overflow-hidden bg-bg-page p-4">
        {/* Background blurs */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute right-0 top-20 h-80 w-80 rounded-full bg-green-light/20 blur-3xl" />
          <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-blue-light/20 blur-3xl" />
        </div>

        <div className="relative mx-auto flex min-h-[calc(100vh-2rem)] w-full max-w-6xl items-center justify-center gap-10 py-10">
          <div className="relative w-full max-w-md animate-fadeIn">
            {/* Logo */}
            <div className="mb-6 text-center">
              <img src={datahublogo} alt="M&A Hub" className="h-16 w-full object-contain" />
            </div>

            <div className="theme-card p-8">

              {/* ══ RESET PASSWORD: REQUEST EMAIL ═══════════════════════════════ */}
              {isReset && resetStep === "request" ? (
                <div className="space-y-6">
                  <div className="text-center space-y-2">
                    <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                      <Mail size={28} className="text-primary" />
                    </div>
                    <h2 className="text-xl font-bold text-text-primary">Reset your password</h2>
                    <p className="text-sm text-secondary">
                      Enter your account email and we&apos;ll send you a verification code.
                    </p>
                  </div>

                  <form onSubmit={handleForgotPasswordSubmit} className="space-y-4">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">
                        Email Address
                      </label>
                      <input
                        type="email"
                        value={resetEmail}
                        onChange={(e) => { setResetEmail(e.target.value); if (error) setError(""); }}
                        required
                        placeholder="you@company.com"
                        className="theme-input h-12 rounded-xl px-4"
                      />
                    </div>

                    {error && (
                      <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3">
                        <p className="text-sm text-negative">{error}</p>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={resetLoading}
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 font-semibold text-white transition-all duration-200 hover:bg-primary-dark hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {resetLoading ? (
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      ) : (
                        <>Send Reset Code</>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => switchMode("login")}
                      className="flex w-full items-center justify-center gap-1.5 text-sm font-semibold text-primary hover:underline"
                    >
                      <ArrowLeft size={14} /> Back to Sign In
                    </button>
                  </form>
                </div>

              ) : isReset && resetStep === "otp" ? (
                /* ══ RESET PASSWORD: VERIFY OTP ═════════════════════════════════ */
                <div className="space-y-6">
                  <div className="text-center space-y-2">
                    <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                      <ShieldCheck size={28} className="text-primary" />
                    </div>
                    <h2 className="text-xl font-bold text-text-primary">Enter verification code</h2>
                    <p className="text-sm text-secondary">
                      We&apos;ve sent a verification code to your email address.
                    </p>
                    <p className="text-sm font-semibold text-primary">
                      {maskEmail(pendingResetEmail)}
                    </p>
                  </div>

                  <div>
                    <label className="mb-3 block text-center text-sm font-medium text-text-primary">
                      Enter 6-digit verification code
                    </label>
                    <div className="flex justify-center gap-2">
                      {otpDigits.map((digit, i) => (
                        <input
                          key={i}
                          type="text"
                          inputMode="numeric"
                          maxLength={1}
                          value={digit}
                          ref={(el) => (otpRefs.current[i] = el)}
                          onChange={(e) => handleOtpChange(i, e.target.value)}
                          onKeyDown={(e) => handleOtpKeyDown(i, e)}
                          onPaste={i === 0 ? handleOtpPaste : undefined}
                          className="h-12 w-10 rounded-xl border border-border-input bg-bg-card text-center text-lg font-bold text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      ))}
                    </div>
                  </div>

                  {(otpError || error) && (
                    <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3">
                      <p className="text-center text-sm text-negative">{otpError || error}</p>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleVerifyResetOtp}
                    disabled={otpLoading || !otpFilled}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 font-semibold text-white transition-all duration-200 hover:bg-primary-dark hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {otpLoading ? (
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    ) : (
                      <><ShieldCheck size={17} /> Verify Code</>
                    )}
                  </button>

                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={handleBackToResetRequest}
                      className="flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-text-primary"
                    >
                      <ArrowLeft size={14} /> Back
                    </button>
                    <button
                      type="button"
                      onClick={handleResendResetOtp}
                      disabled={countdown > 0 || resendLoading}
                      className="flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {resendLoading
                        ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                        : <RotateCcw size={14} />
                      }
                      {countdown > 0 ? `Resend in ${countdown}s` : "Resend Code"}
                    </button>
                  </div>
                </div>

              ) : isReset && resetStep === "newPassword" ? (
                /* ══ RESET PASSWORD: SET NEW PASSWORD ════════════════════════════ */
                <div className="space-y-6">
                  <div className="text-center space-y-2">
                    <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                      <KeyRound size={28} className="text-primary" />
                    </div>
                    <h2 className="text-xl font-bold text-text-primary">Set a new password</h2>
                    <p className="text-sm text-secondary">
                      Choose a new password for your account.
                    </p>
                  </div>

                  <form onSubmit={handleResetPasswordSubmit} className="space-y-4">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">
                        New Password
                      </label>
                      <div className="relative">
                        <input
                          type={showNewPass ? "text" : "password"}
                          value={newPassword}
                          onChange={(e) => { setNewPassword(e.target.value); if (error) setError(""); }}
                          required
                          placeholder="Min. 8 alphanumeric characters"
                          className="theme-input h-12 rounded-xl px-4 pr-12"
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPass((v) => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-secondary"
                        >
                          {showNewPass ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">
                        Confirm New Password
                      </label>
                      <input
                        type="password"
                        value={confirmNewPassword}
                        onChange={(e) => { setConfirmNewPassword(e.target.value); if (error) setError(""); }}
                        required
                        placeholder="Repeat your new password"
                        className="theme-input h-12 rounded-xl px-4"
                      />
                    </div>

                    {error && (
                      <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3">
                        <p className="text-sm text-negative">{error}</p>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={resetLoading}
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 font-semibold text-white transition-all duration-200 hover:bg-primary-dark hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {resetLoading ? (
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      ) : (
                        <><KeyRound size={17} /> Reset Password</>
                      )}
                    </button>
                  </form>
                </div>

              ) : /* ══ OTP VERIFICATION STEP ══════════════════════════════════════ */
              isSignup && step === "verify" ? (
                <div className="space-y-6">
                  <div className="text-center space-y-2">
                    <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                      <ShieldCheck size={28} className="text-primary" />
                    </div>
                    <h2 className="text-xl font-bold text-text-primary">Verify your email</h2>
                    <p className="text-sm text-secondary">
                      We&apos;ve sent a verification code to your email address.
                    </p>
                    <p className="text-sm font-semibold text-primary">
                      {maskEmail(pendingForm?.email || "")}
                    </p>
                  </div>

                  {/* 6 digit boxes */}
                  <div>
                    <label className="mb-3 block text-center text-sm font-medium text-text-primary">
                      Enter 6-digit verification code
                    </label>
                    <div className="flex justify-center gap-2">
                      {otpDigits.map((digit, i) => (
                        <input
                          key={i}
                          type="text"
                          inputMode="numeric"
                          maxLength={1}
                          value={digit}
                          ref={(el) => (otpRefs.current[i] = el)}
                          onChange={(e) => handleOtpChange(i, e.target.value)}
                          onKeyDown={(e) => handleOtpKeyDown(i, e)}
                          onPaste={i === 0 ? handleOtpPaste : undefined}
                          className="h-12 w-10 rounded-xl border border-border-input bg-bg-card text-center text-lg font-bold text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      ))}
                    </div>
                  </div>

                  {(otpError || error) && (
                    <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3">
                      <p className="text-center text-sm text-negative">{otpError || error}</p>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleVerifyOtp}
                    disabled={otpLoading || !otpFilled}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 font-semibold text-white transition-all duration-200 hover:bg-primary-dark hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {otpLoading ? (
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    ) : (
                      <><ShieldCheck size={17} /> Verify &amp; Create Account</>
                    )}
                  </button>

                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={handleBackToForm}
                      className="flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-text-primary"
                    >
                      <ArrowLeft size={14} /> Back
                    </button>
                    <button
                      type="button"
                      onClick={handleResendOtp}
                      disabled={countdown > 0 || resendLoading}
                      className="flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {resendLoading
                        ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                        : <RotateCcw size={14} />
                      }
                      {countdown > 0 ? `Resend in ${countdown}s` : "Resend Code"}
                    </button>
                  </div>
                </div>

              ) : isSignup ? (
                /* ══ REGISTRATION FORM ══════════════════════════════════════════ */
                <>
                  <div className="mb-6">
                    <h2 className="text-xl font-bold text-text-primary">Create broker account</h2>
                    <p className="mt-1 text-sm text-secondary">
                      Register as a broker to access the Broker Portal
                    </p>
                  </div>

                  <form onSubmit={handleSignupSubmit} className="space-y-4">
                    {/* First / Last name */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-text-primary">
                          First Name
                        </label>
                        <input
                          type="text"
                          value={signupForm.firstName}
                          onChange={(e) => setSignupField("firstName", e.target.value)}
                          required
                          placeholder="Jane"
                          className="theme-input h-12 rounded-xl px-4"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-text-primary">
                          Last Name
                        </label>
                        <input
                          type="text"
                          value={signupForm.lastName}
                          onChange={(e) => setSignupField("lastName", e.target.value)}
                          required
                          placeholder="Smith"
                          className="theme-input h-12 rounded-xl px-4"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">
                        Company Name
                      </label>
                      <input
                        type="text"
                        value={signupForm.broker_company}
                        onChange={(e) => setSignupField("broker_company", e.target.value)}
                        placeholder="Company name"
                        className="theme-input h-12 rounded-xl px-4"
                      />
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">
                        Email Address
                      </label>
                      <input
                        type="email"
                        value={signupForm.email}
                        onChange={(e) => setSignupField("email", e.target.value)}
                        required
                        placeholder="you@company.com"
                        className="theme-input h-12 rounded-xl px-4"
                      />
                    </div>

                    {/* US-formatted phone */}
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">
                        Phone Number
                      </label>
                      <div className="flex">
                        <span className="flex h-12 items-center rounded-l-xl border border-r-0 border-[#DDE3EE] bg-[#F4F6FA] px-3 text-sm font-medium text-[#6D6E71]">
                          +1
                        </span>
                        <input
                          type="tel"
                          value={signupForm.phone}
                          onChange={(e) => handlePhoneChange(e.target.value)}
                          placeholder="(555) 000-0000"
                          maxLength={14}
                          className="theme-input h-12 min-w-0 flex-1 rounded-l-none rounded-r-xl px-4"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">
                        Password
                      </label>
                      <div className="relative">
                        <input
                          type={showSignupPass ? "text" : "password"}
                          value={signupForm.password}
                          onChange={(e) => setSignupField("password", e.target.value)}
                          required
                          placeholder="Min. 8 alphanumeric characters"
                          className="theme-input h-12 rounded-xl px-4 pr-12"
                        />
                        <button
                          type="button"
                          onClick={() => setShowSignupPass((v) => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-secondary"
                        >
                          {showSignupPass ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">
                        Confirm Password
                      </label>
                      <input
                        type="password"
                        value={signupForm.confirmPassword}
                        onChange={(e) => setSignupField("confirmPassword", e.target.value)}
                        required
                        placeholder="Repeat your password"
                        className="theme-input h-12 rounded-xl px-4"
                      />
                    </div>

                    {/* CAPTCHA */}
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">
                        Security Check
                      </label>
                      <div className="flex items-center gap-3">
                        <div className="flex h-12 min-w-[120px] select-none items-center justify-center rounded-xl border border-[#DDE3EE] bg-[#F4F6FA] px-4 font-mono text-lg font-bold tracking-widest text-[#05164D]">
                          {captcha.question} = ?
                        </div>
                        <input
                          type="number"
                          value={captchaInput}
                          onChange={(e) => { setCaptchaInput(e.target.value); if (error) setError(""); }}
                          required
                          placeholder="Answer"
                          className="theme-input h-12 w-24 rounded-xl px-4 text-center"
                        />
                      </div>
                    </div>

                    {/* Terms checkbox */}
                    <div className="flex items-start gap-2.5 pt-1">
                      <input
                        id="terms"
                        type="checkbox"
                        checked={termsAccepted}
                        onChange={(e) => { setTermsAccepted(e.target.checked); if (error) setError(""); }}
                        className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-[#05164D]"
                      />
                      <label htmlFor="terms" className="cursor-pointer text-sm leading-snug text-text-muted">
                        I have read and agree to the{" "}
                        <button
                          type="button"
                          onClick={() => setShowTermsModal(true)}
                          className="font-semibold text-primary underline hover:no-underline"
                        >
                          Terms of Service &amp; Privacy Policy
                        </button>
                      </label>
                    </div>

                    {error && (
                      <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3">
                        <p className="text-sm text-negative">{error}</p>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={loading}
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 font-semibold text-white transition-all duration-200 hover:bg-primary-dark hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {loading ? (
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      ) : (
                        <><UserPlus size={17} /> Create Account</>
                      )}
                    </button>

                    <p className="text-center text-sm text-text-muted">
                      Already have an account?{" "}
                      <button
                        type="button"
                        onClick={() => switchMode("login")}
                        className="font-semibold text-primary hover:underline"
                      >
                        Sign In
                      </button>
                    </p>
                  </form>
                </>

              ) : (
                /* ══ LOGIN FORM ═════════════════════════════════════════════════ */
                <>
                  <div className="mb-6">
                    <h2 className="text-xl font-bold text-text-primary">Welcome back</h2>
                    <p className="mt-1 text-sm text-secondary">Sign in to your account to continue</p>
                  </div>

                  <form onSubmit={handleLoginSubmit} className="space-y-4">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">
                        Email Address
                      </label>
                      <input
                        type="email"
                        value={loginForm.email}
                        onChange={(e) => setLoginField("email", e.target.value)}
                        required
                        placeholder="you@company.com"
                        className="theme-input h-12 rounded-xl px-4"
                      />
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">
                        Password
                      </label>
                      <div className="relative">
                        <input
                          type={showPass ? "text" : "password"}
                          value={loginForm.password}
                          onChange={(e) => setLoginField("password", e.target.value)}
                          required
                          placeholder="Enter your password"
                          className="theme-input h-12 rounded-xl px-4 pr-12"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPass((v) => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-secondary"
                        >
                          {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                      <div className="mt-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => switchMode("reset")}
                          className="text-sm font-medium text-primary hover:underline"
                        >
                          Forgot password?
                        </button>
                      </div>
                    </div>

                    {error && (
                      <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3">
                        <p className="text-sm text-negative">{error}</p>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={loading}
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 font-semibold text-white transition-all duration-200 hover:bg-primary-dark hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {loading ? (
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      ) : (
                        <><LogIn size={17} /> Sign In</>
                      )}
                    </button>

                    <p className="text-center text-sm text-text-muted">
                      New to M&amp;A Hub?{" "}
                      <button
                        type="button"
                        onClick={() => switchMode("signup")}
                        className="font-semibold text-primary hover:underline"
                      >
                        Sign up here
                      </button>
                    </p>
                  </form>
                </>
              )}

              <p className="mt-6 text-center text-xs text-text-muted">
                © 2026 M&amp;A Hub • Privacy • Terms
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
