import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { forgotPasswordRequest, resetPasswordRequest } from "../lib/api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validatePassword(pw) {
  if ((pw || "").length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    return "Password must include at least one letter and one number.";
  }
  return null;
}

export default function ForgotPassword() {
  const navigate = useNavigate();

  // "request" → enter email; "reset" → enter code + new password; "done" → success
  const [step, setStep] = useState("request");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPass, setShowPass] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  async function handleRequest(e) {
    e.preventDefault();
    setError("");
    setInfo("");
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) {
      setError("Please enter a valid email address.");
      return;
    }
    setLoading(true);
    try {
      const res = await forgotPasswordRequest({ email: normalized });
      setInfo(
        res?.message ||
          "If an account exists for that email, a reset code has been sent."
      );
      setStep("reset");
    } catch (err) {
      setError(err?.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(e) {
    e.preventDefault();
    setError("");
    const code = otp.trim();
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    const pwError = validatePassword(password);
    if (pwError) {
      setError(pwError);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await resetPasswordRequest({
        email: email.trim().toLowerCase(),
        otp: code,
        new_password: password,
      });
      setStep("done");
    } catch (err) {
      setError(err?.message || "Password reset failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F4F6FA] px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <h1 className="mb-1 text-2xl font-bold text-text-primary">Reset your password</h1>

        {step === "request" && (
          <>
            <p className="mb-6 text-sm text-text-muted">
              Enter your account email and we&apos;ll send you a 6-digit reset code.
            </p>
            <form onSubmit={handleRequest} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary">
                  Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@company.com"
                  className="theme-input h-12 rounded-xl px-4"
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="h-12 w-full rounded-xl bg-secondary font-semibold text-white disabled:opacity-60"
              >
                {loading ? "Sending…" : "Send reset code"}
              </button>
            </form>
          </>
        )}

        {step === "reset" && (
          <>
            <p className="mb-6 text-sm text-text-muted">
              {info || "Enter the code sent to your email and choose a new password."}
            </p>
            <form onSubmit={handleReset} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary">
                  Reset code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  required
                  placeholder="6-digit code"
                  className="theme-input h-12 rounded-xl px-4 tracking-[0.5em]"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary">
                  New password
                </label>
                <div className="relative">
                  <input
                    type={showPass ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="Min. 8 alphanumeric characters"
                    className="theme-input h-12 rounded-xl px-4 pr-16"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-text-muted hover:text-secondary"
                  >
                    {showPass ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary">
                  Confirm new password
                </label>
                <input
                  type={showPass ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  placeholder="Re-enter new password"
                  className="theme-input h-12 rounded-xl px-4"
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="h-12 w-full rounded-xl bg-secondary font-semibold text-white disabled:opacity-60"
              >
                {loading ? "Resetting…" : "Reset password"}
              </button>
              <button
                type="button"
                onClick={() => { setStep("request"); setError(""); }}
                className="w-full text-sm text-text-muted hover:text-secondary"
              >
                Use a different email
              </button>
            </form>
          </>
        )}

        {step === "done" && (
          <>
            <p className="mb-6 text-sm text-text-muted">
              Your password has been reset. You can now sign in with your new password.
            </p>
            <button
              type="button"
              onClick={() => navigate("/login")}
              className="h-12 w-full rounded-xl bg-secondary font-semibold text-white"
            >
              Go to sign in
            </button>
          </>
        )}

        <div className="mt-6 text-center text-sm">
          <Link to="/login" className="text-secondary hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
