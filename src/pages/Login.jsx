import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { Eye, EyeOff, LogIn, UserPlus } from "lucide-react";
import datahublogo from "../assets/datahublogo.png";

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

export default function Login() {
  const [mode, setMode] = useState("login");
  const [loginForm, setLoginForm] = useState(LOGIN_FORM);
  const [signupForm, setSignupForm] = useState(SIGNUP_FORM);
  const [showPass, setShowPass] = useState(false);
  const [showSignupPass, setShowSignupPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login, signupBroker, error, setError } = useAuth();

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setError("");
    setShowPass(false);
    setShowSignupPass(false);
  };

  const setLoginField = (field, value) => {
    setLoginForm((current) => ({ ...current, [field]: value }));
    if (error) setError("");
  };

  const setSignupField = (field, value) => {
    setSignupForm((current) => ({ ...current, [field]: value }));
    if (error) setError("");
  };

  const validateSignup = () => {
    const name = signupForm.name.trim();
    const email = signupForm.email.trim();
    const password = signupForm.password;

    if (!name) return "Full name is required.";
    if (!email || !isValidEmail(email)) return "Please enter a valid email address.";
    if (!password || password.length < 8) return "Password must be at least 8 characters.";
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return "Password must include at least one letter and one number.";
    }
    if (password !== signupForm.confirmPassword) return "Passwords do not match.";
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

    setLoading(true);
    try {
      await signupBroker({
        name: signupForm.name.trim(),
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
              alt="DataHub"
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
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-primary">
                    Your Name
                  </label>
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

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-primary">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={signupForm.phone}
                    onChange={(e) => setSignupField("phone", e.target.value)}
                    placeholder="+91 98765 43210"
                    className="theme-input h-12 rounded-xl px-4"
                  />
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
                      onClick={() => setShowSignupPass((value) => !value)}
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
                      onClick={() => setShowPass((value) => !value)}
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
            )}

            <p className="mt-6 text-center text-xs text-text-muted">
               © 2026 M&A Hub • Privacy • Terms
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
