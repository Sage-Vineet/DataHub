import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Building2, FolderOpen, LogOut, X, MoreHorizontal, MessageSquare } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import datahublogo from '../../assets/datahublogo.png';

const userNav = [
  { label: 'Company List', icon: LayoutDashboard, to: '/user/portal-dashboard' },
  { label: 'Documents', icon: FolderOpen, to: '/user/documents' },
  { label: 'Messages', icon: MessageSquare, to: '/user/messages' },
];

export default function UserSidebar({ onClose }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <aside className="flex h-full min-h-screen w-[240px] flex-col border-r border-[#E6E8F0] bg-white shadow-xl">
      <div className="border-b border-[#EEF0F5] px-4 pb-5 pt-4">
        <div className="flex items-center justify-between gap-3">
          <button onClick={() => navigate('/user/portal-dashboard')} className="flex items-center gap-3 text-left">
            <img src={datahublogo} alt="DataHub" className="h-10 w-auto object-contain" />
            <div>
              <p className="text-sm font-bold text-[#05164D]">User Portal</p>
              <p className="text-[11px] text-[#6D6E71]">Assigned companies</p>
            </div>
          </button>
          {onClose && (
            <button onClick={onClose} className="rounded-md p-1 text-[#6D6E71] transition-colors hover:bg-[#F4F6FA] hover:text-[#05164D]">
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {userNav.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition-all ${
                  isActive
                    ? 'bg-[#EEF6E0] text-[#05164D]'
                    : 'text-[#6D6E71] hover:bg-[#F4F6FA] hover:text-[#05164D]'
                }`
              }
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-[#EEF0F5] px-4 py-4">
        <div className="mb-3 flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-[#F8F9FC]">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#05164D] text-xs font-bold text-white">
            {user?.avatar || 'U'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[#05164D]">{user?.name}</p>
            <p className="mt-1 truncate text-[11px] uppercase tracking-wide text-[#A5A5A5]">User Access</p>
          </div>
          <button className="text-[#A5A5A5] transition-colors hover:text-[#05164D]">
            <MoreHorizontal size={16} />
          </button>
        </div>
        <button
          onClick={handleLogout}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#E5E7EF] px-3 py-2.5 text-sm font-semibold text-[#6D6E71] transition-colors hover:bg-red-50 hover:text-[#C62026]"
        >
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
