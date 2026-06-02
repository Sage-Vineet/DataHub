import { useState, useRef, useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useMessageNotifications } from "../../context/MessageNotificationsContext";
import {
  LayoutDashboard,
  Building2,
  Bell,
  LogOut,
  ClipboardList,
  X,
  MoreHorizontal,
  FileText,
  MessageSquare,
  Settings,
} from "lucide-react";
import datahublogo from "../../assets/datahublogo.png";

const brokerNav = [
  { label: "Dashboard", icon: LayoutDashboard, to: "/broker/dashboard" },
  { label: "Companies", icon: Building2, to: "/broker/companies" },
];

const clientNav = [
  { label: "Dashboard", icon: LayoutDashboard, to: "/client/dashboard" },
  { label: "My Requests", icon: ClipboardList, to: "/client/requests" },
  { label: "Documents", icon: FileText, to: "/client/upload" },
  { label: "Messages", icon: MessageSquare, to: "/client/messages" },
  { label: "Reminders", icon: Bell, to: "/client/reminders" },
];

export default function Sidebar({ onClose }) {
  const { user, logout } = useAuth();
  const { unreadCount } = useMessageNotifications();
  const navigate = useNavigate();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const userMenuRef = useRef(null);
  const nav = user?.role === "broker" ? brokerNav : clientNav;
  const accountLabel = user?.role === "broker" ? "Administrator" : user?.role === "user" ? "User" : "Client";

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  useEffect(() => {
    function handleClickOutside(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setShowUserMenu(false);
      }
    }
    if (showUserMenu) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showUserMenu]);

  return (
    <aside
      className="flex h-full min-h-screen w-[210px] flex-col border-r border-border bg-bg-card text-text-primary"
      style={{ boxShadow: "var(--shadow-sidebar)" }}
    >
      <div className="border-b border-border px-3 pb-5 pt-3">
        <div className="relative flex items-center justify-center">
          <button
            onClick={() => navigate("/")}
            className="flex items-center justify-center"
          >
            <img
              src={datahublogo}
              alt="M&A Hub"
              className="h-10 w-auto object-contain"
            />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="absolute -right-1 top-1/2 -translate-y-1/2 rounded-md p-1 text-text-muted transition-colors hover:bg-bg-page hover:text-text-primary"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
        {nav.map((item) => {
          const Icon = item.icon;

          return (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                `relative flex items-center gap-3 rounded-md px-3 py-2.5 text-[14px] font-medium transition-all duration-200 ${
                  isActive
                    ? "bg-[#EEF6E0] text-primary font-semibold"
                    : "text-secondary hover:bg-[#F0F7E6] hover:text-text-primary"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <div className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                  )}
                  <Icon
                    size={18}
                    className={isActive ? "text-primary" : "text-text-muted"}
                  />
                  <span>{item.label}</span>
                  {item.label === "Messages" && unreadCount > 0 && (
                    <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-negative px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Client/non-broker users keep the bottom user section in the sidebar */}
      {user?.role !== "broker" && (
        <div className="border-t border-border px-3 pb-4 pt-4">
          <div className="relative" ref={userMenuRef}>
            {showUserMenu && (
              <div
                className="absolute bottom-full left-0 right-0 mb-1 rounded-[var(--radius-card)] border border-border bg-white p-2 animate-fadeIn"
                style={{ boxShadow: "var(--shadow-dropdown)" }}
              >
                <div className="mb-1 border-b border-border px-3 py-2">
                  <p className="text-sm font-semibold text-text-primary">{user?.name}</p>
                  <p className="text-xs text-secondary">{user?.email}</p>
                </div>
                <button
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-secondary transition-colors hover:bg-bg-page hover:text-text-primary"
                  onClick={() => {
                    setShowUserMenu(false);
                    if (onClose) onClose();
                    navigate("/client/profile");
                  }}
                >
                  <Settings size={14} />
                  Profile Settings
                </button>
              </div>
            )}

            <button
              onClick={() => setShowUserMenu((v) => !v)}
              className="mb-1 flex w-full items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-bg-page"
            >
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-white">
                {user?.avatar}
              </div>
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate text-[14px] font-medium leading-none text-text-primary">
                  {user?.name}
                </p>
                <p className="mt-1 truncate text-[12px] leading-none text-text-muted">
                  {`${accountLabel}${user?.company ? ` · ${user.company}` : ""}`}
                </p>
              </div>
              <MoreHorizontal size={16} className="shrink-0 text-text-muted" />
            </button>
          </div>
          <button
            onClick={() => setShowLogoutConfirm(true)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-[14px] font-medium text-secondary transition-colors hover:bg-red-50 hover:text-negative"
          >
            <LogOut size={16} />
            Sign Out
          </button>
          {showLogoutConfirm && (
            <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-white/40 backdrop-blur-sm">
              <div className="w-full max-w-sm rounded-2xl border border-border bg-white p-6 shadow-2xl">
                <h3 className="text-base font-bold text-text-primary">Sign out?</h3>
                <p className="mt-1 text-sm text-secondary">You will be returned to the login screen.</p>
                <div className="mt-5 flex gap-3">
                  <button
                    onClick={() => setShowLogoutConfirm(false)}
                    className="flex-1 rounded-xl border border-border py-2.5 text-sm font-semibold text-secondary transition-colors hover:bg-bg-page"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleLogout}
                    className="flex-1 rounded-xl bg-negative py-2.5 text-sm font-semibold text-white transition-colors hover:opacity-90"
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
