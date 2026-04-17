import { useMemo, useState } from 'react';
import { Building2, ChevronDown, Menu, Search } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export default function UserNavbar({ onMenuClick }) {
  const { user } = useAuth();
  const [showProfile, setShowProfile] = useState(false);

  const workspaceLabel = useMemo(() => {
    const totalAssigned = user?.assignedCompanies?.length || user?.companyIds?.length || 0;
    return totalAssigned > 0 ? `${totalAssigned} Assigned Compan${totalAssigned === 1 ? 'y' : 'ies'}` : 'User Portal';
  }, [user]);

  return (
    <header className="sticky top-0 z-20 border-b border-[#E7EAF1] bg-white/92 backdrop-blur-md">
      <div className="flex items-center justify-between px-4 py-3 lg:px-6">
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuClick}
            className="rounded-md border border-[#E5E7EF] bg-white p-2 text-[#6D6E71] transition-colors hover:bg-[#F4F6FA] lg:hidden"
          >
            <Menu size={18} />
          </button>
          <div className="hidden items-center gap-3 sm:flex">
            <span className="text-sm font-bold text-[#05164D]">User Portal</span>
            <span className="text-xs text-[#A5A5A5]">
              {new Date().toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative hidden lg:block">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#A5A5A5]" />
            <input
              type="text"
              placeholder="Search assigned companies..."
              className="h-10 min-w-[260px] rounded-full border border-[#E5E7EF] bg-[#F8F9FC] pl-9 pr-4 text-sm text-[#05164D] outline-none"
            />
          </div>

          <div className="relative">
            <button
              onClick={() => setShowProfile((value) => !value)}
              className="flex items-center gap-2 rounded-full border border-[#E5E7EF] bg-white px-2 py-1.5 pr-3 text-sm font-semibold text-[#05164D] shadow-sm"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#05164D] text-xs font-bold text-white">
                {user?.avatar || 'U'}
              </div>
              <div className="hidden items-center gap-2 sm:flex">
                <Building2 size={14} className="text-[#6D6E71]" />
                <span>{workspaceLabel}</span>
              </div>
              <ChevronDown size={14} className="text-[#A5A5A5]" />
            </button>

            {showProfile && (
              <div className="absolute right-0 top-12 z-50 w-56 rounded-2xl border border-[#E5E7EF] bg-white p-2 shadow-xl animate-fadeIn">
                <div className="mb-1 border-b border-[#EEF0F5] px-3 py-2">
                  <p className="text-sm font-semibold text-[#05164D]">{user?.name}</p>
                  <p className="text-xs text-[#6D6E71]">{user?.email}</p>
                </div>
                <button
                  className="w-full rounded-xl px-3 py-2 text-left text-sm font-medium text-[#6D6E71] transition-colors hover:bg-[#F8F9FC] hover:text-[#05164D]"
                  onClick={() => setShowProfile(false)}
                >
                  Assigned access
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
