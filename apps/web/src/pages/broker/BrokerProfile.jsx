import { useState, useEffect } from 'react';
import { ArrowLeft, Lock, User, Building2, ChevronRight, ShieldCheck, X, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { updateUserRequest, listCompaniesRequest } from '../../lib/api';

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview' },
  { id: 'sign-security', label: 'Sign in & security' },
  { id: 'profile', label: 'Profile' },
  { id: 'business-profile', label: 'Business profile' },
  { id: 'data-privacy', label: 'Data & privacy' },
];

// ─────────────────────────────── Shared UI ─────────────────────────────────

function Modal({ title, onClose, onSave, saving, error, children, saveLabel = 'Save' }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl mx-4">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {children}

        {error && (
          <div className="mt-3 rounded-xl border border-red-100 bg-red-50 px-4 py-3 flex items-start gap-2.5">
            <AlertCircle size={15} className="text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        <div className="mt-5 flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-[#8BC53D] rounded-lg hover:bg-[#476E2C] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldInput({ label, value, onChange, type = 'text', placeholder, required, hint, max }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        max={max}
        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
      />
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

function formatUSPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '').slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function validateUSPhone(value) {
  if (!value || !String(value).trim()) return '';
  const digits = String(value).replace(/\D/g, '');
  if (digits.length !== 10) return 'Please enter a valid 10-digit US phone number, e.g. (555) 000-0000.';
  return '';
}

function validateProfileValue(label, value, { required, type } = {}) {
  const trimmed = String(value || '').trim();
  if (required && !trimmed) return `${label} is required.`;

  if (type === 'date' && trimmed) {
    const [year, month, day] = trimmed.split('-').map(Number);
    const selectedDate = new Date(year, month - 1, day);
    const isValidDate =
      /^\d{4}-\d{2}-\d{2}$/.test(trimmed) &&
      selectedDate.getFullYear() === year &&
      selectedDate.getMonth() === month - 1 &&
      selectedDate.getDate() === day;

    if (!isValidDate) {
      return `Please enter a valid ${label.toLowerCase()}.`;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (selectedDate > today) return `${label} cannot be in the future.`;
  }

  return '';
}

function InfoRow({ label, value, placeholder, isPassword, verified, verifiedNote, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center justify-between border-b border-gray-100 px-6 py-4 last:border-0 hover:bg-gray-50 transition-colors ${onClick ? 'cursor-pointer' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-700">{label}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          {isPassword ? (
            <p className="text-sm tracking-widest text-gray-900">••••••••</p>
          ) : value ? (
            <p className="text-sm text-gray-900">{value}</p>
          ) : (
            <p className="text-sm text-blue-600">{placeholder}</p>
          )}
          {verified === true && (
            <>
              <span className="text-xs font-semibold text-green-600">Verified</span>
              {verifiedNote && <span className="text-xs text-green-600">({verifiedNote})</span>}
            </>
          )}
          {verified === false && value && (
            <span className="text-xs font-semibold text-blue-600 hover:underline">Verify email</span>
          )}
        </div>
      </div>
      {onClick && <ChevronRight size={16} className="ml-4 flex-shrink-0 text-gray-400" />}
    </div>
  );
}

function ManageCard({ icon: Icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-3 rounded-xl border border-gray-200 bg-white p-6 shadow-sm transition-all hover:border-gray-300 hover:shadow-md active:scale-[0.98]"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-50">
        <Icon size={22} className="text-gray-600" />
      </div>
      <span className="text-sm font-medium text-gray-700">{label}</span>
    </button>
  );
}

function PageHeader({ icon: Icon, title, subtitle }) {
  return (
    <div className="mb-8 flex flex-col items-center text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
        <Icon size={24} className="text-gray-600" />
      </div>
      <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
      <p className="mt-1 text-sm text-gray-500">{subtitle}</p>
    </div>
  );
}

// ──────────────────────────────── Overview ──────────────────────────────────

function OverviewPage({ onNavigate, user }) {
  const firstName = user?.name?.split(' ')[0] || 'there';
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Hello {firstName}!</h1>
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">Manage your account</h2>
        <p className="mt-1 text-sm text-gray-500">
          Here's where you control information that spans all your profile settings.
        </p>
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ManageCard icon={Lock} label="Sign in & security" onClick={() => onNavigate('sign-security')} />
          <ManageCard icon={User} label="Profile" onClick={() => onNavigate('profile')} />
          <ManageCard icon={Building2} label="Business profile" onClick={() => onNavigate('business-profile')} />
          <ManageCard icon={ShieldCheck} label="Data & privacy" onClick={() => onNavigate('data-privacy')} />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── Sign in & Security ─────────────────────────────

function PasswordModal({ user, onClose, onSuccess }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));

  const handleSave = async () => {
    if (saving) return;
    setError('');
    if (!form.current.trim()) return setError('Please enter your current password.');
    if (!form.next.trim()) return setError('Please enter a new password.');
    if (form.next.length < 8) return setError('New password must be at least 8 characters.');
    if (!/[A-Za-z]/.test(form.next) || !/\d/.test(form.next)) {
      return setError('Password must include at least one letter and one number.');
    }
    if (form.next !== form.confirm) return setError('Passwords do not match. Please try again.');

    setSaving(true);
    try {
      await updateUserRequest(user.id, { current_password: form.current, password: form.next });
      await onSuccess(null, 'Password updated successfully.');
    } catch (err) {
      setError(err.message || 'Failed to update password. Please check your current password and try again.');
      setSaving(false);
    }
  };

  return (
    <Modal title="Change password" onClose={onClose} onSave={handleSave} saving={saving} error={error}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Current password<span className="text-red-500 ml-0.5">*</span>
          </label>
          <div className="relative">
            <input
              type={showCurrent ? 'text' : 'password'}
              value={form.current}
              onChange={(e) => setField('current')(e.target.value)}
              placeholder="Enter your current password"
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 pr-10 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowCurrent((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showCurrent ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            New password<span className="text-red-500 ml-0.5">*</span>
          </label>
          <div className="relative">
            <input
              type={showNext ? 'text' : 'password'}
              value={form.next}
              onChange={(e) => setField('next')(e.target.value)}
              placeholder="Min. 8 characters, include a letter and number"
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 pr-10 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowNext((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showNext ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Confirm new password<span className="text-red-500 ml-0.5">*</span>
          </label>
          <input
            type="password"
            value={form.confirm}
            onChange={(e) => setField('confirm')(e.target.value)}
            placeholder="Repeat your new password"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
          />
        </div>
      </div>
    </Modal>
  );
}

function PhoneModal({ user, onClose, onSuccess }) {
  const [phone, setPhone] = useState(formatUSPhone(user?.phone || ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handlePhoneChange = (raw) => {
    setPhone(formatUSPhone(raw));
    if (error) setError('');
  };

  const handleSave = async () => {
    if (saving) return;
    setError('');
    const validationError = validateUSPhone(phone);
    if (validationError) return setError(validationError);

    setSaving(true);
    try {
      const updatedUser = await updateUserRequest(user.id, { phone: phone.trim() || null });
      await onSuccess(updatedUser, 'Phone number updated successfully.');
    } catch (err) {
      setError(err.message || 'Failed to update phone number. Please try again.');
      setSaving(false);
    }
  };

  return (
    <Modal title="Phone number" onClose={onClose} onSave={handleSave} saving={saving} error={error}>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">Phone number</label>
        <div className="flex">
          <span className="flex h-[42px] items-center rounded-l-lg border border-r-0 border-gray-300 bg-gray-50 px-3 text-sm font-medium text-gray-500 select-none">
            +1
          </span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => handlePhoneChange(e.target.value)}
            placeholder="(555) 000-0000"
            maxLength={14}
            className="min-w-0 flex-1 rounded-l-none rounded-r-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
          />
        </div>
        <p className="mt-1.5 text-xs text-gray-500">Optional. Leave empty to remove your phone number.</p>
      </div>
    </Modal>
  );
}

function SignSecurityPage({ user, onRefresh }) {
  const [modal, setModal] = useState(null);
  const [localUser, setLocalUser] = useState(user);
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(''), 4000);
    return () => clearTimeout(t);
  }, [success]);

  useEffect(() => {
    setLocalUser(user);
  }, [user]);

  const handleSuccess = async (updatedUser, message) => {
    // Apply updated fields immediately so the UI reflects changes before refresh
    if (updatedUser) setLocalUser((prev) => ({ ...prev, ...updatedUser }));
    setModal(null);
    setSuccess(message || 'Profile updated successfully.');
    // Refresh global state; merge carefully so a stale cache doesn't undo our update
    const refreshedUser = await onRefresh();
    if (refreshedUser) {
      setLocalUser((prev) => ({
        ...refreshedUser,
        // Preserve fields that were in updatedUser — they're the ground truth
        ...(updatedUser ? Object.fromEntries(
          Object.entries(updatedUser).filter(([, v]) => v !== undefined),
        ) : {}),
      }));
    }
  };

  return (
    <div>
      {modal === 'password' && (
        <PasswordModal user={localUser} onClose={() => setModal(null)} onSuccess={handleSuccess} />
      )}
      {modal === 'phone' && (
        <PhoneModal user={localUser} onClose={() => setModal(null)} onSuccess={handleSuccess} />
      )}

      <PageHeader
        icon={Lock}
        title="Sign in & security"
        subtitle="Update the way you sign in to your account."
      />

      <div className="mx-auto max-w-lg overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {success && (
          <div className="border-b border-green-100 bg-green-50 px-6 py-3 text-sm font-medium text-green-700">
            {success}
          </div>
        )}
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900">Sign in info</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            We'll use this info to help make sure only you can sign in to your account.
          </p>
        </div>
        <InfoRow label="User ID" value={localUser?.email} placeholder="No user ID available" />
        <InfoRow
          label="Email address"
          value={localUser?.email}
          placeholder="Add your email address"
        />
        <InfoRow label="Change Password" onClick={() => setModal('password')} />
        <InfoRow
          label="Phone"
          value={localUser?.phone}
          placeholder="Add your phone number"
          onClick={() => setModal('phone')}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────── Profile ────────────────────────────────────

function ProfileFieldModal({ title, label, value, required, type = 'text', placeholder, max, onClose, onSave }) {
  const [fieldValue, setFieldValue] = useState(value || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (saving) return;
    setError('');
    const validationError = validateProfileValue(label, fieldValue, { required, type });
    if (validationError) return setError(validationError);

    setSaving(true);
    try {
      await onSave(fieldValue.trim());
      onClose();
    } catch (err) {
      setError(err.message || `Failed to update ${label.toLowerCase()}. Please try again.`);
      setSaving(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} onSave={handleSave} saving={saving} error={error}>
      <FieldInput
        label={label}
        value={fieldValue}
        onChange={setFieldValue}
        type={type}
        placeholder={placeholder}
        required={required}
        max={max}
      />
    </Modal>
  );
}

function ProfilePage({ user, onRefresh }) {
  const [editingField, setEditingField] = useState(null);
  const [localValues, setLocalValues] = useState({});
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(''), 4000);
    return () => clearTimeout(t);
  }, [success]);

  // localValues takes priority over user prop so saved values show immediately
  const resolve = (field, fallback) =>
    field in localValues ? localValues[field] : (fallback ?? '');

  const handleSave = async (field, value) => {
    const updatedUser = await updateUserRequest(user.id, { [field]: value || null });
    // Use the server-confirmed value if present, otherwise fall back to what the user typed
    const savedValue = updatedUser?.[field] !== undefined ? updatedUser[field] : value;
    setLocalValues((prev) => ({ ...prev, [field]: savedValue ?? '' }));
    // Refresh global user state, but never let it overwrite the field we just edited
    // (the auth cache may still hold pre-update data for up to 60 s)
    const refreshedUser = await onRefresh();
    if (refreshedUser) {
      setLocalValues((prev) => ({
        ...prev, ...Object.fromEntries(
          Object.entries(refreshedUser).filter(([k]) => k !== field),
        ), [field]: savedValue ?? ''
      }));
    }
    const fieldLabel = fields.find((f) => f.key === field)?.label || 'Profile';
    setSuccess(`${fieldLabel} updated successfully.`);
  };

  const rawDob = (resolve('date_of_birth', user?.date_of_birth ?? user?.dateOfBirth) || '').slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);
  const displayDob = rawDob
    ? new Date(rawDob + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  const fields = [
    {
      key: 'broker_company',
      label: 'Company Name',
      value: resolve('broker_company', user?.broker_company),
      placeholder: 'Add your company name',
      required: true,
      title: 'Edit company name',
    },
    {
      key: 'name',
      label: 'Name',
      value: resolve('name', user?.name),
      placeholder: 'Add your name',
      required: true,
      title: 'Edit name',
    },
    {
      key: 'date_of_birth',
      label: 'Date of birth',
      value: rawDob,
      displayValue: displayDob,
      placeholder: 'Add your date of birth',
      type: 'date',
      max: todayDate,
      title: 'Edit date of birth',
    },
    {
      key: 'occupation',
      label: 'Occupation',
      value: resolve('occupation', user?.occupation),
      placeholder: 'Add your occupation',
      title: 'Edit occupation',
    },
    {
      key: 'address',
      label: 'Address',
      value: resolve('address', user?.address),
      placeholder: 'Add your address',
      title: 'Edit address',
    },
  ];

  const active = fields.find((f) => f.key === editingField);

  return (
    <div>
      {active && (
        <ProfileFieldModal
          title={active.title}
          label={active.label}
          value={active.value}
          required={active.required}
          type={active.type}
          placeholder={active.placeholder}
          max={active.max}
          onClose={() => setEditingField(null)}
          onSave={(value) => handleSave(active.key, value)}
        />
      )}

      <PageHeader icon={User} title="Profile" subtitle="This info helps us personalize your experience." />

      <div className="mx-auto max-w-lg overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {success && (
          <div className="border-b border-green-100 bg-green-50 px-6 py-3 text-sm font-medium text-green-700">
            {success}
          </div>
        )}
        {fields.map((f) => (
          <InfoRow
            key={f.key}
            label={f.label}
            value={f.displayValue ?? f.value}
            placeholder={f.placeholder}
            onClick={() => setEditingField(f.key)}
          />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────── Business Profile ───────────────────────────────

function BusinessProfilePage() {
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listCompaniesRequest()
      .then(setCompanies)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <PageHeader
        icon={Building2}
        title="Business profile"
        subtitle="Companies associated with your account."
      />

      {loading ? (
        <div className="mx-auto max-w-2xl py-12 text-center text-sm text-gray-500">
          Loading companies…
        </div>
      ) : companies.length === 0 ? (
        <div className="mx-auto max-w-2xl rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
          <Building2 size={32} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm font-medium text-gray-500">No companies found</p>
          <p className="mt-1 text-xs text-gray-400">You haven't been assigned to any companies yet.</p>
        </div>
      ) : (
        <div className="mx-auto max-w-2xl grid gap-4">
          {companies.map((company) => (
            <div
              key={company.id}
              className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-6 py-4 shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gray-100">
                <Building2 size={20} className="text-gray-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-gray-900 truncate">{company.name}</p>
                {company.email && (
                  <p className="mt-0.5 text-xs text-gray-500 truncate">{company.email}</p>
                )}
                {company.phone && (
                  <p className="mt-0.5 text-xs text-gray-500">{company.phone}</p>
                )}
              </div>
              {company.status && (
                <span
                  className={`flex-shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${company.status === 'active'
                    ? 'bg-green-50 text-green-700'
                    : 'bg-gray-100 text-gray-600'
                    }`}
                >
                  {company.status.charAt(0).toUpperCase() + company.status.slice(1)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────── Data & Privacy ──────────────────────────────

function DataPrivacyPage() {
  return (
    <div>
      <PageHeader
        icon={ShieldCheck}
        title="Data & privacy"
        subtitle="Stay in control of your data and how it's used."
      />
    </div>
  );
}

// ─────────────────────────────── Root page ──────────────────────────────────

export default function BrokerProfile() {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [activePage, setActivePage] = useState('overview');

  const renderPage = () => {
    switch (activePage) {
      case 'overview':
        return <OverviewPage onNavigate={setActivePage} user={user} />;
      case 'sign-security':
        return <SignSecurityPage user={user} onRefresh={refreshUser} />;
      case 'profile':
        return <ProfilePage user={user} onRefresh={refreshUser} />;
      case 'business-profile':
        return <BusinessProfilePage />;
      case 'data-privacy':
        return <DataPrivacyPage />;
      default:
        return <OverviewPage onNavigate={setActivePage} user={user} />;
    }
  };

  return (
    <div className="space-y-5">
      {/* Back button */}
      <button
        onClick={() => navigate('/broker/dashboard')}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-[#6D6E71] transition-colors hover:bg-[#F4F6FA] hover:text-[#050505]"
      >
        <ArrowLeft size={15} />
        Back to Dashboard
      </button>

      <div className="flex min-h-full gap-8">
        <aside className="w-48 flex-shrink-0">
          <nav className="space-y-0.5">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                onClick={() => setActivePage(item.id)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${activePage === item.id
                  ? 'bg-gray-100 font-semibold text-gray-900'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1">{renderPage()}</main>
      </div>
    </div>
  );
}
