import { Building2, Mail, Phone, ShieldCheck, UserRound } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

function DetailCard({ icon: Icon, label, value }) {
  return (
    <div className="rounded-2xl bg-[#F8F9FC] p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-[#476E2C] shadow-sm">
          <Icon size={18} />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#A5A5A5]">{label}</p>
          <p className="mt-1 break-words text-sm font-semibold text-[#050505]">{value || 'Not available'}</p>
        </div>
      </div>
    </div>
  );
}

export default function ClientProfile() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Profile Settings</h1>
        <p className="mt-0.5 text-sm text-[#6D6E71]">Review your client portal profile and assigned company details.</p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
        <div className="rounded-3xl bg-white p-6 shadow-card">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-[#05164D] text-2xl font-bold text-white">
              {user?.avatar || 'C'}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#A5A5A5]">Client Account</p>
              <h2 className="mt-1 text-2xl font-bold text-[#050505]">{user?.name || 'Client User'}</h2>
              <p className="mt-1 text-sm text-[#6D6E71]">{user?.email || 'No email available'}</p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <DetailCard icon={UserRound} label="Full Name" value={user?.name} />
            <DetailCard icon={Mail} label="Email" value={user?.email} />
            <DetailCard icon={Phone} label="Phone" value={user?.phone} />
            <DetailCard icon={ShieldCheck} label="Portal Role" value="Client" />
          </div>
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-card">
          <h3 className="text-lg font-bold text-[#05164D]">Company Access</h3>
          <div className="mt-5 space-y-4">
            <DetailCard icon={Building2} label="Company" value={user?.company} />
            <DetailCard icon={ShieldCheck} label="Access Level" value="Client workspace access" />
          </div>
        </div>
      </div>
    </div>
  );
}
