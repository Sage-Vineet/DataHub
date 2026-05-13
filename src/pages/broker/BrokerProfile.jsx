import { useState } from 'react';
import { Lock, User, Building2, ChevronRight, Layers, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview' },
  { id: 'sign-security', label: 'Sign in & security' },
  { id: 'profile', label: 'Profile' },
  { id: 'business-profile', label: 'Business profile' },
  { id: 'data-privacy', label: 'Data & privacy' },
  { id: 'products-billing', label: 'Products & billing' },
];

function InfoRow({ label, value, placeholder, isPassword, verified, verifiedNote }) {
  return (
    <div className="flex cursor-pointer items-center justify-between border-b border-gray-100 px-6 py-4 last:border-0 hover:bg-gray-50 transition-colors">
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
              {verifiedNote && (
                <span className="text-xs text-green-600">({verifiedNote})</span>
              )}
            </>
          )}
          {verified === false && value && (
            <span className="text-xs font-semibold text-blue-600 cursor-pointer hover:underline">
              Verify email
            </span>
          )}
        </div>
      </div>
      <ChevronRight size={16} className="ml-4 flex-shrink-0 text-gray-400" />
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
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <ManageCard icon={Lock} label="Sign in & security" onClick={() => onNavigate('sign-security')} />
          <ManageCard icon={User} label="Profile" onClick={() => onNavigate('profile')} />
          <ManageCard icon={Building2} label="Business profile" onClick={() => onNavigate('business-profile')} />
          <ManageCard icon={ShieldCheck} label="Data & privacy" onClick={() => onNavigate('data-privacy')} />
          <ManageCard icon={Layers} label="Products & billing" onClick={() => onNavigate('products-billing')} />
        </div>
      </div>
    </div>
  );
}

function SignSecurityPage({ user }) {
  return (
    <div>
      <PageHeader icon={Lock} title="Sign in & security" subtitle="Update the way you sign in to your account." />

      <div className="mx-auto max-w-lg overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900">Sign in info</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            We'll use this info to help make sure only you can sign in to your account.
          </p>
        </div>
        <InfoRow label="User ID" value={user?.email} placeholder="No user ID available" />
        <InfoRow
          label="Email address"
          value={user?.email}
          placeholder="Add your email address"
          verified={user?.email_verified ?? false}
        />
        <InfoRow label="Password" isPassword />
        <InfoRow
          label="Phone"
          value={user?.phone}
          placeholder="Add your phone number"
          verified={user?.phone ? (user?.phone_verified ?? true) : undefined}
          verifiedNote={user?.phone_verified_method ?? (user?.phone ? 'text message' : undefined)}
        />
      </div>
    </div>
  );
}

function ProfilePage({ user }) {
  return (
    <div>
      <PageHeader icon={User} title="Profile" subtitle="This info helps us personalize your experience." />

      <div className="mx-auto max-w-lg overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <InfoRow label="Name" value={user?.name} placeholder="Add your name" />
        <InfoRow
          label="Date of birth"
          value={user?.date_of_birth ?? user?.dateOfBirth}
          placeholder="Add your date of birth"
        />
        <InfoRow label="Occupation" value={user?.occupation} placeholder="Add your occupation" />
        <InfoRow label="Address" value={user?.address} placeholder="Add your address" />
      </div>
    </div>
  );
}

function BusinessProfilePage() {
  return (
    <div>
      <PageHeader icon={Building2} title="Business profile" subtitle="Keep your business info updated." />
    </div>
  );
}

function DataPrivacyPage() {
  return (
    <div>
      <PageHeader icon={ShieldCheck} title="Data & privacy" subtitle="Stay in control of your data and how it's used." />
    </div>
  );
}

function ProductsBillingPage() {
  return (
    <div>
      <PageHeader
        icon={Layers}
        title="Products & billing"
        subtitle="Manage your products, subscriptions, and payments in one place."
      />
    </div>
  );
}

export default function BrokerProfile() {
  const { user } = useAuth();
  const [activePage, setActivePage] = useState('overview');

  const renderPage = () => {
    switch (activePage) {
      case 'overview':
        return <OverviewPage onNavigate={setActivePage} user={user} />;
      case 'sign-security':
        return <SignSecurityPage user={user} />;
      case 'profile':
        return <ProfilePage user={user} />;
      case 'business-profile':
        return <BusinessProfilePage />;
      case 'data-privacy':
        return <DataPrivacyPage />;
      case 'products-billing':
        return <ProductsBillingPage />;
      default:
        return <OverviewPage onNavigate={setActivePage} user={user} />;
    }
  };

  return (
    <div className="flex min-h-full gap-8">
      <aside className="w-48 flex-shrink-0">
        <nav className="space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setActivePage(item.id)}
              className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                activePage === item.id
                  ? 'bg-gray-100 font-semibold text-gray-900'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        {renderPage()}
      </main>
    </div>
  );
}
