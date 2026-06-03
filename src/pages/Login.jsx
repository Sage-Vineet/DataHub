import { useState, useRef, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { Eye, EyeOff, LogIn, UserPlus, ShieldCheck, RotateCcw, ArrowLeft } from "lucide-react";
import datahublogo from "../assets/datahublogo.png";
import { sendVerificationOtpRequest, verifyVerificationOtpRequest } from "../lib/api";

const LOGIN_FORM = { email: "", password: "" };
const SIGNUP_FORM = {
  name: "",
  broker_company: "",
  email: "",
  phone: "",
  password: "",
  confirmPassword: "",
};

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function maskEmail(email) {
  const at = (email || "").indexOf("@");
  if (at <= 0) return email;
  const user   = email.slice(0, at);
  const domain = email.slice(at);
  return user.slice(0, Math.min(2, user.length)) + "***" + domain;
}

export default function Login() {
  const [mode, setMode]               = useState("login");
  const [step, setStep]               = useState("form"); // "form" | "verify"
  const [loginForm, setLoginForm]     = useState(LOGIN_FORM);
  const [signupForm, setSignupForm]   = useState(SIGNUP_FORM);
  const [pendingForm, setPendingForm] = useState(null);   // saved while on verify step
  const [showPass, setShowPass]             = useState(false);
  const [showSignupPass, setShowSignupPass] = useState(false);
  const [loading, setLoading]         = useState(false);
  const [otpDigits, setOtpDigits]     = useState(["", "", "", "", "", ""]);
  const [otpError, setOtpError]       = useState("");
  const [otpLoading, setOtpLoading]   = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [countdown, setCountdown]     = useState(0);
  const otpRefs = useRef([]);

  const { login, signupBroker, error, setError } = useAuth();

  // Countdown ticker
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setStep("form");
    setOtpDigits(["", "", "", "", "", ""]);
    setOtpError("");
    setError("");
    setShowPass(false);
    setShowSignupPass(false);
  };

  const setLoginField  = (field, value) => { setLoginForm((c) => ({ ...c, [field]: value })); if (error) setError(""); };
  const setSignupField = (field, value) => { setSignupForm((c) => ({ ...c, [field]: value })); if (error) setError(""); };

  const validateSignup = () => {
    const name     = signupForm.name.trim();
    const email    = signupForm.email.trim();
    const password = signupForm.password;
    if (!name) return "Full name is required.";
    if (!email || !isValidEmail(email)) return "Please enter a valid email address.";
    if (!password || password.length < 8) return "Password must be at least 8 characters.";
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password))
      return "Password must include at least one letter and one number.";
    if (password !== signupForm.confirmPassword) return "Passwords do not match.";
    return "";
  };

  // ── Login ──────────────────────────────────────────────────────────────────
  const handleLoginSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    try {
      await login(loginForm.email, loginForm.password);
    } finally {
      setLoading(false);
    }
  };

  // ── Step 1: validate form and send OTP ────────────────────────────────────
  const handleSignupSubmit = async (event) => {
    event.preventDefault();
    const validationError = validateSignup();
    if (validationError) { setError(validationError); return; }

    setLoading(true);
    setError("");
    try {
      await sendVerificationOtpRequest({ email: signupForm.email.trim() });
      setPendingForm({ ...signupForm });
      setOtpDigits(["", "", "", "", "", ""]);
      setOtpError("");
      setStep("verify");
      setCountdown(60);
      // Auto-focus first OTP box after render
      setTimeout(() => otpRefs.current[0]?.focus(), 50);
    } catch (err) {
      setError(err.message || "Failed to send verification code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // ── OTP input handlers ────────────────────────────────────────────────────
  const handleOtpChange = (index, value) => {
    if (!/^\d*$/.test(value)) return;
    const next = [...otpDigits];
    next[index] = value.slice(-1);
    setOtpDigits(next);
    setOtpError("");
    if (value && index < 5) otpRefs.current[index + 1]?.focus();
  };

  const handleOtpKeyDown = (index, e) => {
    if (e.key === "Backspace" && !otpDigits[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!pasted) return;
    const next = ["", "", "", "", "", ""];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setOtpDigits(next);
    const focusIdx = Math.min(pasted.length, 5);
    otpRefs.current[focusIdx]?.focus();
  };

  // ── Step 2: verify OTP then create account ────────────────────────────────
  const handleVerifyOtp = async () => {
    const otp = otpDigits.join("");
    if (otp.length !== 6) { setOtpError("Please enter the complete 6-digit code."); return; }
    setOtpLoading(true);
    setOtpError("");
    try {
      const result = await verifyVerificationOtpRequest({
        email: pendingForm.email.trim(),
        otp,
      });
      // Account creation — verification token is included in the payload
      await signupBroker({
        name:               pendingForm.name.trim(),
        broker_company:     pendingForm.broker_company.trim(),
        email:              pendingForm.email.trim(),
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

  // ── Resend OTP ────────────────────────────────────────────────────────────
  const handleResendOtp = async () => {
    setResendLoading(true);
    setOtpError("");
    try {
      await sendVerificationOtpRequest({ email: pendingForm.email.trim() });
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

  const isSignup = mode === "signup";
  const otpFilled = otpDigits.join("").length === 6;

  return (
    <div className="relative min-h-screen overflow-hidden bg-bg-page p-4">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute right-0 top-20 h-80 w-80 rounded-full bg-green-light/20 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-blue-light/20 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-[calc(100vh-2rem)] w-full max-w-6xl items-center justify-center gap-10 py-10">
        <div className="relative w-full max-w-md animate-fadeIn">
          <div className="mb-6 text-center">
            <img src={datahublogo} alt="DataHub" className="h-16 w-full object-contain" />
          </div>

          <div className="theme-card p-8">

            {/* ── Email Verification step ──────────────────────────────────── */}
            {isSignup && step === "verify" ? (
              <div className="space-y-6">
                <div className="text-center space-y-2">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 mb-3">
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

                {/* 6 OTP boxes */}
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

                {/* Error display (OTP errors + account creation errors) */}
                {(otpError || error) && (
                  <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3">
                    <p className="text-center text-sm text-negative">{otpError || error}</p>
                  </div>
                )}

                {/* Verify button */}
                <button
                  type="button"
                  onClick={handleVerifyOtp}
                  disabled={otpLoading || !otpFilled}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 font-semibold text-white transition-all duration-200 hover:bg-primary-dark hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {otpLoading ? (
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : (
                    <>
                      <ShieldCheck size={17} />
                      Verify &amp; Create Account
                    </>
                  )}
                </button>

                {/* Back + Resend row */}
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={handleBackToForm}
                    className="flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-text-primary"
                  >
                    <ArrowLeft size={14} />
                    Back
                  </button>

                  <button
                    type="button"
                    onClick={handleResendOtp}
                    disabled={countdown > 0 || resendLoading}
                    className="flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {resendLoading ? (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                    ) : (
                      <RotateCcw size={14} />
                    )}
                    {countdown > 0 ? `Resend in ${countdown}s` : "Resend Code"}
                  </button>
                </div>
              </div>

            ) : isSignup ? (
              /* ── Registration form (unchanged) ───────────────────────────── */
              <>
                <div className="mb-6">
                  <h2 className="text-xl font-bold text-text-primary">Create broker account</h2>
                  <p className="mt-1 text-sm text-secondary">
                    Register as a broker to access the Broker Portal
                  </p>
                </div>

                <form onSubmit={handleSignupSubmit} className="space-y-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-primary">Your Name</label>
                    <input
                      type="text"
                      value={signupForm.name}
                      onChange={(e) => setSignupField("name", e.target.value)}
                      required
                      placeholder="Your full name"
                      className="theme-input h-12 rounded-xl px-4"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-primary">Company Name</label>
                    <input
                      type="text"
                      value={signupForm.broker_company}
                      onChange={(e) => setSignupField("broker_company", e.target.value)}
                      placeholder="Company name"
                      className="theme-input h-12 rounded-xl px-4"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-primary">Email Address</label>
                    <input
                      type="email"
                      value={signupForm.email}
                      onChange={(e) => setSignupField("email", e.target.value)}
                      required
                      placeholder="you@company.com"
                      className="theme-input h-12 rounded-xl px-4"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-primary">Phone Number</label>
                    <input
                      type="tel"
                      value={signupForm.phone}
                      onChange={(e) => setSignupField("phone", e.target.value)}
                      placeholder="+91 98765 43210"
                      className="theme-input h-12 rounded-xl px-4"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-primary">Password</label>
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
                    <label className="mb-1.5 block text-sm font-medium text-text-primary">Confirm Password</label>
                    <input
                      type="password"
                      value={signupForm.confirmPassword}
                      onChange={(e) => setSignupField("confirmPassword", e.target.value)}
                      required
                      placeholder="Min. 8 alphanumeric characters"
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
                    disabled={loading}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 font-semibold text-white transition-all duration-200 hover:bg-primary-dark hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loading ? (
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    ) : (
                      <>
                        <UserPlus size={17} />
                        Create Account
                      </>
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
              /* ── Login form (unchanged) ──────────────────────────────────── */
              <>
                <div className="mb-6">
                  <h2 className="text-xl font-bold text-text-primary">Welcome back</h2>
                  <p className="mt-1 text-sm text-secondary">Sign in to your account to continue</p>
                </div>

                <form onSubmit={handleLoginSubmit} className="space-y-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-primary">Email Address</label>
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
                    <label className="mb-1.5 block text-sm font-medium text-text-primary">Password</label>
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
                      <>
                        <LogIn size={17} />
                        Sign In
                      </>
                    )}
                  </button>

                  <p className="text-center text-sm text-text-muted">
                    Don&apos;t have a broker account?{" "}
                    <button
                      type="button"
                      onClick={() => switchMode("signup")}
                      className="font-semibold text-primary hover:underline"
                    >
                      Create Account
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
  );
}
