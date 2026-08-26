import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, ChevronDown, LogOut, Menu, Settings } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import MessageNotificationsMenu from './MessageNotificationsMenu';
import datahublogo from '../../assets/datahublogo.png';

/**
 * One word for the signed-in person's role.
 *
 * This was hardcoded to "Administrator" for every user, while the workspace
 * sidebar called the same person "Broker" — so the product disagreed with itself
 * about who you were depending on which chrome you happened to be looking at.
 */
function roleLabel(user) {
  switch (user?.role) {
    case 'admin': return 'Administrator';
    case 'broker': return 'Broker';
    case 'client': return 'Client';
    case 'buyer': return 'Buyer';
    case 'user': return 'User';
    default: return '';
  }
}

export default function Navbar({ onMenuClick }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showSignoutConfirm, setShowSignoutConfirm] = useState(false);
  const menuRef = useRef(null);

  const workspaceLabel = useMemo(() => {
    if (!user) return '';
    if (user.company) return user.company;
    if (user.role === 'user') {
      const totalAssigned = user.assignedCompanies?.length || user.companyIds?.length || 0;
      return totalAssigned > 0 ? `${totalAssigned} Assigned Client${totalAssigned === 1 ? '' : 's'}` : 'User Workspace';
    }
    return user.role || '';
  }, [user]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowUserMenu(false);
      }
    }
    if (showUserMenu) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showUserMenu]);

  const handleLogout = async () => {
    setShowSignoutConfirm(false);
    await logout();
    navigate('/login', { replace: true });
  };

  const isBroker = user?.role === 'broker';

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-border bg-bg-card">
        <div className="flex items-center justify-between px-4 py-3 lg:px-6">
          {/* Left — logo (broker) or mobile menu trigger (others) */}
          <div className="flex items-center gap-3">
            {isBroker ? (
              <>
                <button onClick={() => navigate('/broker/dashboard')} className="flex items-center">
                  <img src={datahublogo} alt="M&A Hub" className="h-9 w-auto object-contain" />
                </button>
              </>
            ) : (
              <button
                onClick={onMenuClick}
                className="rounded-md border border-border bg-bg-card p-2 text-secondary transition-colors hover:bg-bg-page lg:hidden"
              >
                <Menu size={18} />
              </button>
            )}
          </div>

          {/* Right */}
          <div className="flex items-center gap-3">
            <MessageNotificationsMenu portal={isBroker ? 'broker' : 'client'} />

            {/* Company label for non-broker roles */}
            {!isBroker && workspaceLabel && (
              <div className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                <Building2 size={15} className="text-text-muted" />
                <span>{workspaceLabel}</span>
              </div>
            )}

            {/* Broker user menu */}
            {isBroker && (
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setShowUserMenu((v) => !v)}
                  className="flex items-center gap-2.5 rounded-xl border border-border bg-bg-card px-3 py-2 text-sm transition-colors hover:bg-bg-page"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#05164D] text-[11px] font-bold text-white">
                    {user?.avatar}
                  </div>
                  <div className="hidden text-left sm:block">
                    <p className="text-[13px] font-semibold leading-none text-text-primary">{user?.name}</p>
                    <p className="mt-0.5 text-[11px] leading-none text-text-muted">{roleLabel(user)}</p>
                  </div>
                  <ChevronDown
                    size={14}
                    className={`text-text-muted transition-transform duration-200 ${showUserMenu ? 'rotate-180' : ''}`}
                  />
                </button>

                {showUserMenu && (
                  <div
                    className="absolute right-0 top-full z-50 mt-2 w-56 rounded-2xl border border-border bg-white py-1 animate-fadeIn"
                    style={{ boxShadow: 'var(--shadow-dropdown)' }}
                  >
                    <div className="border-b border-border px-4 py-3">
                      <p className="text-sm font-semibold text-text-primary">{user?.name}</p>
                      <p className="mt-0.5 text-xs text-text-muted">{user?.email}</p>
                    </div>
                    <button
                      onClick={() => { setShowUserMenu(false); navigate('/broker/profile'); }}
                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-secondary transition-colors hover:bg-bg-page hover:text-text-primary"
                    >
                      <Settings size={15} />
                      Profile Settings
                    </button>
                    <div className="mx-3 my-1 border-t border-border" />
                    <button
                      onClick={() => { setShowUserMenu(false); setShowSignoutConfirm(true); }}
                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-[#C62026] transition-colors hover:bg-red-50"
                    >
                      <LogOut size={15} />
                      Sign Out
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Sign-out confirm modal */}
      {showSignoutConfirm && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-white/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold text-text-primary">Sign out?</h3>
            <p className="mt-1 text-sm text-secondary">You will be returned to the login screen.</p>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setShowSignoutConfirm(false)}
                className="flex-1 rounded-xl border border-border py-2.5 text-sm font-semibold text-secondary transition-colors hover:bg-bg-page"
              >
                Cancel
              </button>
              <button
                onClick={handleLogout}
                className="flex-1 rounded-xl bg-[#C62026] py-2.5 text-sm font-semibold text-white transition-colors hover:opacity-90"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
