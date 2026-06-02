import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { Eye, EyeOff, LogIn, UserPlus, X } from "lucide-react";
import datahublogo from "../assets/datahublogo.png";

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

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function formatUSPhone(raw) {
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function generateCaptcha() {
  const a = Math.floor(Math.random() * 12) + 1;
  const b = Math.floor(Math.random() * 12) + 1;
  const useAdd = Math.random() > 0.4;
  if (useAdd) return { question: `${a} + ${b}`, answer: a + b };
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return { question: `${hi} − ${lo}`, answer: hi - lo };
}

function TermsModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[#E8EDF5] px-6 py-4">
          <h3 className="text-base font-bold text-[#050505]">Terms of Service &amp; Privacy Policy</h3>
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

export default function Login() {
  const [mode, setMode] = useState("login");
  const [loginForm, setLoginForm] = useState(LOGIN_FORM);
  const [signupForm, setSignupForm] = useState(SIGNUP_FORM);
  const [showPass, setShowPass] = useState(false);
  const [showSignupPass, setShowSignupPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [captcha] = useState(generateCaptcha);
  const [captchaInput, setCaptchaInput] = useState("");
  const { login, signupBroker, error, setError } = useAuth();

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setError("");
    setShowPass(false);
    setShowSignupPass(false);
    setTermsAccepted(false);
    setCaptchaInput("");
  };

  const setLoginField = (field, value) => {
    setLoginForm((current) => ({ ...current, [field]: value }));
    if (error) setError("");
  };

  const setSignupField = (field, value) => {
    setSignupForm((current) => ({ ...current, [field]: value }));
    if (error) setError("");
  };

  const handlePhoneChange = (raw) => {
    setSignupField("phone", formatUSPhone(raw));
  };

  const validateSignup = () => {
    const firstName = signupForm.firstName.trim();
    const lastName = signupForm.lastName.trim();
    const email = signupForm.email.trim();
    const password = signupForm.password;

    if (!firstName) return "First name is required.";
    if (!lastName) return "Last name is required.";
    if (!email || !isValidEmail(email)) return "Please enter a valid email address.";
    if (!password || password.length < 8) return "Password must be at least 8 characters.";
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return "Password must include at least one letter and one number.";
    }
    if (password !== signupForm.confirmPassword) return "Passwords do not match.";
    if (parseInt(captchaInput, 10) !== captcha.answer) return "Captcha answer is incorrect.";
    if (!termsAccepted) return "You must agree to the Terms of Service to continue.";
    return "";
  };

  const handleLoginSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    try {
      await login(loginForm.email, loginForm.password);
    } finally {
      setLoading(false);
    }
  };

  const handleSignupSubmit = async (event) => {
    event.preventDefault();
    const validationError = validateSignup();
    if (validationError) {
      setError(validationError);
      return;
    }

    const fullName = `${signupForm.firstName.trim()} ${signupForm.lastName.trim()}`;
    setLoading(true);
    try {
      await signupBroker({
        name: fullName,
        broker_company: signupForm.broker_company.trim(),
        email: signupForm.email.trim(),
        phone: signupForm.phone.trim(),
        password: signupForm.password,
        confirmPassword: signupForm.confirmPassword,
      });
    } finally {
      setLoading(false);
    }
  };

  const isSignup = mode === "signup";

  return (
    <>
      {showTermsModal && <TermsModal onClose={() => setShowTermsModal(false)} />}

      <div className="relative min-h-screen overflow-hidden bg-bg-page p-4">
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute right-0 top-20 h-80 w-80 rounded-full bg-green-light/20 blur-3xl" />
          <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-blue-light/20 blur-3xl" />
        </div>

        <div className="relative mx-auto flex min-h-[calc(100vh-2rem)] w-full max-w-6xl items-center justify-center gap-10 py-10">
          <div className="relative w-full max-w-md animate-fadeIn">
            <div className="mb-6 text-center">
              <img
                src={datahublogo}
                alt="M&A Hub"
                className="h-16 w-full object-contain"
              />
            </div>

            <div className="theme-card p-8">
              <div className="mb-6">
                <h2 className="text-xl font-bold text-text-primary">
                  {isSignup ? "Create broker account" : "Welcome back"}
                </h2>
                <p className="mt-1 text-sm text-secondary">
                  {isSignup
                    ? "Register as a broker to access the Broker Portal"
                    : "Sign in to your account to continue"}
                </p>
              </div>

              {isSignup ? (
                <form onSubmit={handleSignupSubmit} className="space-y-4">
                  {/* First Name / Last Name */}
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

                  {/* US Phone */}
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
                      <div className="flex h-12 min-w-[120px] items-center justify-center rounded-xl border border-[#DDE3EE] bg-[#F4F6FA] px-4 font-mono text-lg font-bold tracking-widest text-[#05164D] select-none">
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
                    <label htmlFor="terms" className="text-sm text-text-muted leading-snug cursor-pointer">
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
              ) : (
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
              )}

              <p className="mt-6 text-center text-xs text-text-muted">
                 © 2026 M&A Hub • Privacy • Terms
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
