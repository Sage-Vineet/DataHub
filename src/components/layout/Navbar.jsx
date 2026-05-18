import { useMemo } from 'react';
import { Menu, Search, Building2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import MessageNotificationsMenu from './MessageNotificationsMenu';

export default function Navbar({ onMenuClick }) {
  const { user } = useAuth();
  const workspaceLabel = useMemo(() => {
    if (!user) return '';
    if (user.company) return user.company;
    if (user.role === 'user') {
      const totalAssigned = user.assignedCompanies?.length || user.companyIds?.length || 0;
      return totalAssigned > 0 ? `${totalAssigned} Assigned Client${totalAssigned === 1 ? '' : 's'}` : 'User Workspace';
    }
    return user.role || '';
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

          {workspaceLabel && (
            <div
              className="flex items-center gap-2 rounded-md bg-primary px-4 text-[14px] font-semibold text-white"
              style={{ height: 40 }}
            >
              <Building2 size={16} />
              <span>{workspaceLabel}</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
