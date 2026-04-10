import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Eye, EyeOff, LogIn, ShieldCheck } from 'lucide-react';

import datahublogo from '../assets/datahublogo.png';


const demoCredentials = [
  { role: 'Broker', email: 'broker@leo.com', password: 'broker123', color: '#8BC53D', bg: '#C9E4A4' },
  { role: 'Client', email: 'client@infosys.com', password: 'client123', color: '#00648F', bg: '#A7DCF7' },
];

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login, error, setError } = useAuth();

  const fillDemo = (cred) => {
    setEmail(cred.email);
    setPassword(cred.password);
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(email, password);
    } finally {
      setLoading(false);
    }
  };

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
            <img src={datahublogo} alt="DataHub" className="h-16 w-auto object-contain" />

            <p className="mt-1 text-sm text-secondary">Secure Document Management Platform</p>
          </div>

          <div className="theme-card p-8">
            <div className="mb-6">
              <h2 className="text-xl font-bold text-text-primary">Welcome back</h2>
              <p className="mt-1 text-sm text-secondary">Sign in to your account to continue</p>
            </div>

            <div className="mb-6 grid grid-cols-2 gap-2">
              {demoCredentials.map((cred) => (
                <button
                  key={cred.role}
                  onClick={() => fillDemo(cred)}
                  style={{ background: cred.bg, color: cred.color }}
                  className="flex items-center gap-2 rounded-md px-3 py-2.5 text-xs font-semibold transition-all hover:opacity-80 hover:scale-[1.01]"
                >
                  <ShieldCheck size={14} />
                  Demo {cred.role}
                </button>
              ))}
            </div>

            <div className="relative mb-5 flex items-center">
              <div className="flex-1 border-t border-border" />
              <span className="bg-white px-3 text-xs text-text-muted">or enter credentials</span>
              <div className="flex-1 border-t border-border" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary">Email Address</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  placeholder="you@company.com"
                  className="theme-input h-12 rounded-xl px-4"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary">Password</label>
                <div className="relative">
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    placeholder="••••••••"
                    className="theme-input h-12 rounded-xl px-4 pr-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(v => !v)}
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
            </form>

            <p className="mt-6 text-center text-xs text-text-muted">
              Protected by DataRoom Security · All rights reserved
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
