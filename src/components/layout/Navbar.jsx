import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Search, ChevronDown, Building2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import MessageNotificationsMenu from './MessageNotificationsMenu';

export default function Navbar({ onMenuClick }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [showProfile, setShowProfile] = useState(false);
  const workspaceLabel = useMemo(() => {
    if (!user) return 'Workspace';
    if (user.company) return user.company;
    if (user.role === 'user') {
      const totalAssigned = user.assignedCompanies?.length || user.companyIds?.length || 0;
      return totalAssigned > 0 ? `${totalAssigned} Assigned Client${totalAssigned === 1 ? '' : 's'}` : 'User Workspace';
    }
    return user.role || 'Workspace';
  }, [user]);

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg-card">
      <div className="flex items-center justify-between px-4 py-4 lg:px-6">
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuClick}
            className="rounded-md border border-border bg-bg-card p-2 text-secondary transition-colors hover:bg-bg-page lg:hidden"
          >
            <Menu size={18} />
          </button>
          <div className="hidden items-center gap-2 sm:flex">
            <span className="text-[13px] font-medium text-text-muted">Workspace</span>
            <span className="text-[13px] font-medium text-text-muted">
              {new Date().toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {user?.role !== 'client' && (
            <div className="relative hidden sm:block">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                placeholder="Search requests, companies..."
                className="theme-input h-10 min-w-[280px] pl-10"
              />
            </div>
          )}

          <MessageNotificationsMenu portal={user?.role === 'broker' ? 'broker' : 'client'} />

          <div className="relative">
            <button
              onClick={() => {
                setShowProfile((value) => !value);
              }}
              className="flex min-w-[150px] items-center justify-between gap-2 rounded-md bg-primary px-4 text-[14px] font-semibold text-white transition-all hover:bg-primary-dark active:scale-[0.98]"
              style={{ height: 40 }}
            >
              <div className="flex items-center gap-2">
                <Building2 size={16} />
                <span>{workspaceLabel}</span>
              </div>
              <ChevronDown size={14} />
            </button>

            {showProfile && (
              <div
                className="absolute right-0 top-12 z-50 w-56 rounded-[var(--radius-card)] border border-border bg-white p-2 animate-fadeIn"
                style={{ boxShadow: 'var(--shadow-dropdown)' }}
              >
                <div className="mb-1 border-b border-border px-3 py-2">
                  <p className="text-sm font-semibold text-text-primary">{user?.name}</p>
                  <p className="text-xs text-secondary">{user?.email}</p>
                </div>
                <button
                  className="w-full rounded-md px-3 py-2 text-left text-sm text-secondary transition-colors hover:bg-bg-page hover:text-text-primary"
                  onClick={() => {
                    setShowProfile(false);
                    if (user?.role === 'client') {
                      navigate('/client/profile');
                    }
                  }}
                >
                  Profile Settings
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
