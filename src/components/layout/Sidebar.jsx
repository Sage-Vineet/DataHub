import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import {
  LayoutDashboard,
  Building2,
  Bell,
  LogOut,
  Upload,
  ClipboardList,
  Database,
  X,
  MoreHorizontal,
  LifeBuoy,
} from "lucide-react";
import datahublogo from "../../assets/datahublogo.png";

const brokerNav = [
  { label: "Dashboard", icon: LayoutDashboard, to: "/broker/dashboard" },
  { label: "Companies", icon: Building2, to: "/broker/companies" },
  { label: "Help & Support", icon: LifeBuoy, to: "/support" },
];

const clientNav = [
  { label: "Dashboard", icon: LayoutDashboard, to: "/client/dashboard" },
  { label: "My Requests", icon: ClipboardList, to: "/client/requests" },
  { label: "Upload Documents", icon: Upload, to: "/client/upload" },
  { label: "Reminders", icon: Bell, to: "/client/reminders" },
  { label: "QuickBooks", icon: Database, to: "/client/connections" },
  { label: "Help & Support", icon: LifeBuoy, to: "/support" },
];

export default function Sidebar({ onClose }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const nav = user?.role === "broker" ? brokerNav : clientNav;
  const accountLabel = user?.role === "broker" ? "Administrator" : user?.role === "user" ? "User" : "Seller";

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

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
              alt="DataHub"
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
                `relative flex items-center gap-3 rounded-md px-3 py-2.5 text-[14px] font-medium transition-all duration-200 ${isActive
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
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-border px-3 pb-4 pt-4">
        <div className="mb-1 flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-bg-page">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-white">
            {user?.avatar}
          </div>
          <div className="min-w-0 flex-1 text-left">
            <p className="truncate text-[14px] font-medium leading-none text-text-primary">
              {user?.name}
            </p>
            <p className="mt-1 truncate text-[12px] leading-none text-text-muted">
              {user?.role === "broker" ? accountLabel : `${accountLabel}${user?.company ? ` · ${user.company}` : ""}`}
            </p>
          </div>
          <button className="text-text-muted transition-colors hover:text-text-primary">
            <MoreHorizontal size={16} />
          </button>
        </div>
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-[14px] font-medium text-secondary transition-colors hover:bg-red-50 hover:text-negative"
        >
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
