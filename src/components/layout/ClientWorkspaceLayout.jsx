import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Bell,
  Briefcase,
  Building2,
  ChevronDown,
  ClipboardList,
  FolderOpen,
  LayoutDashboard,
  Link2,
  LogOut,
  Menu,
  MoreHorizontal,
  Receipt,
  Scale,
  Settings,
  Users,
  X,
  BarChart3,
  Activity,
  TrendingUp,
  MessageSquare,
  Calculator,
  FileCheck,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useMessageNotifications } from "../../context/MessageNotificationsContext";
import { listCompaniesRequest } from "../../lib/api";
import MessageNotificationsMenu from "./MessageNotificationsMenu";
import datahublogo from "../../assets/datahublogo.png";
import ActiveSourceIndicator from "../common/ActiveSourceIndicator";

function companyLogo(name = "") {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function WorkspaceSidebar({ company, onClose }) {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const { notifications } = useMessageNotifications();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const userMenuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setShowUserMenu(false);
      }
    }
    if (showUserMenu) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showUserMenu]);
  const [dataroomOpen, setDataroomOpen] = useState(true);
  const isDataroomRoute = location.pathname.includes("/dataroom/");
  const isDataroomExpanded = dataroomOpen || isDataroomRoute;

  const basePath = `/broker/client/${clientId}`;
  const mainNav = [
    // { label: "Dashboard", icon: LayoutDashboard, to: `${basePath}/dashboard` },
    {
      label: "Analytics",
      icon: TrendingUp,
      to: `${basePath}/analytics`,
    },
    { label: "Invoices", icon: Receipt, to: `${basePath}/invoices` },
    { label: "Reports", icon: BarChart3, to: `${basePath}/reports` },
    { label: "EBITDA Calculation", icon: Calculator, to: `${basePath}/ebitda` },
    {
      label: "Bank Reconciliation",
      icon: Scale,
      to: `${basePath}/reconciliation`,
    },
    {
      label: "Tax Reconciliation",
      icon: FileCheck,
      to: `${basePath}/tax-reconciliation`,
    },
    { label: "Connections", icon: Link2, to: `${basePath}/connections` },
  ];

  const dataroomNav = [
    {
      label: "Requests",
      icon: ClipboardList,
      to: `${basePath}/dataroom/requests`,
    },
    {
      label: "Documents",
      icon: FolderOpen,
      to: `${basePath}/dataroom/documents`,
    },
    { label: "Messages", icon: MessageSquare, to: `${basePath}/dataroom/messages` },
    { label: "Users", icon: Users, to: `${basePath}/dataroom/users` },
    { label: "Reminders", icon: Bell, to: `${basePath}/dataroom/reminders` },
    { label: "Activity", icon: Activity, to: `${basePath}/dataroom/activity` },
  ];
  const companyMessageCount = notifications.filter((item) => String(item.companyId) === String(clientId)).length;

  return (
    <aside
      className="flex h-full min-h-screen w-[240px] flex-col border-r border-border bg-bg-card"
      style={{ boxShadow: "var(--shadow-sidebar)" }}
    >
      <div className="border-b border-border px-3 pb-5 pt-3">
        <div className="relative flex items-center justify-center">
          <img
            src={datahublogo}
            alt="M&A Hub"
            className="h-10 w-auto object-contain"
          />

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

      <div className="border-b border-border px-3 py-4">
        <button
          onClick={() => navigate("/broker/dashboard")}
          className="mb-3 flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-secondary transition-colors hover:bg-bg-page hover:text-text-primary"
        >
          <ArrowLeft size={13} />
          All Companies
        </button>

        <div className="rounded-[var(--radius-card)] border border-border bg-bg-page p-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-sm font-semibold text-white">
              {company.logo}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold text-text-primary">
                {company.project_name || company.name}
              </p>
              <p className="truncate text-[12px] text-text-muted">
                {company.industry || "Client company"}
              </p>
            </div>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-0.5">
          {mainNav.map((item) => {
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
        </div>

        <div className="mt-5">
          <button
            onClick={() => setDataroomOpen((value) => !value)}
            className={`flex w-full items-center justify-between rounded-md px-3 py-2.5 text-[14px] font-semibold transition-all ${isDataroomRoute
              ? "bg-[#EEF6E0] text-primary"
              : "text-text-primary hover:bg-bg-page"
              }`}
          >
            <span className="flex items-center gap-3">
              <FolderOpen
                size={18}
                className={isDataroomRoute ? "text-primary" : "text-text-muted"}
              />
              DataRoom
            </span>
            <ChevronDown
              size={16}
              className={`transition-transform ${isDataroomExpanded ? "rotate-180" : ""}`}
            />
          </button>

          {isDataroomExpanded && (
            <div className="mt-1 space-y-0.5 pl-3">
              {dataroomNav.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={onClose}
                    className={({ isActive }) =>
                      `relative flex items-center gap-3 rounded-md px-3 py-2.5 text-[13px] font-medium transition-all duration-200 ${isActive
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
                          size={16}
                          className={
                            isActive ? "text-primary" : "text-text-muted"
                          }
                        />
                        <span>{item.label}</span>
                        {item.label === "Messages" && companyMessageCount > 0 && (
                          <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-negative px-1.5 py-0.5 text-[10px] font-bold text-white">
                            {companyMessageCount > 9 ? "9+" : companyMessageCount}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          )}
        </div>
      </nav>

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
                  navigate("/broker/profile");
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
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-white">
              {user?.avatar}
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-[14px] font-medium leading-none text-text-primary">
                {user?.name}
              </p>
              <p className="mt-1 truncate text-[12px] leading-none text-text-muted">
                Broker
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
                  onClick={async () => { await logout(); navigate("/login", { replace: true }); }}
                  className="flex-1 rounded-xl bg-negative py-2.5 text-sm font-semibold text-white transition-colors hover:opacity-90"
                >
                  Sign Out
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// Module-level cache so the companies list is fetched at most once per session,
// regardless of how many times WorkspaceTopbar mounts or the company switches.
let cachedSwitchCompanies = null;

function WorkspaceTopbar({ company, onMenuClick }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [showSwitch, setShowSwitch] = useState(false);
  const [companies, setCompanies] = useState(cachedSwitchCompanies ?? []);
  const switchRef = useRef(null);

  useEffect(() => {
    if (!showSwitch) return undefined;

    const handleOutsideClick = (event) => {
      if (switchRef.current && !switchRef.current.contains(event.target)) {
        setShowSwitch(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, [showSwitch]);

  useEffect(() => {
    if (cachedSwitchCompanies) return; // already populated — skip fetch

    let cancelled = false;

    listCompaniesRequest()
      .then((data) => {
        if (!cancelled) {
          const mapped = data.map((item) => ({
            ...item,
            logo: item.logo || companyLogo(item.name),
          }));
          cachedSwitchCompanies = mapped;
          setCompanies(mapped);
        }
      })
      .catch(() => {
        if (!cancelled) setCompanies([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
          <MessageNotificationsMenu portal="broker" companyId={company.id} />

          <ActiveSourceIndicator />

          <div className="relative" ref={switchRef}>
            <button
              onClick={() => setShowSwitch((value) => !value)}
              className="flex min-w-[150px] items-center justify-between gap-2 rounded-md bg-primary px-4 text-[14px] font-semibold text-white transition-all hover:bg-primary-dark active:scale-[0.98]"
              style={{ height: 40 }}
            >
              <div className="flex items-center gap-2">
                <Building2 size={16} />
                <span className="hidden sm:inline">Switch Company</span>
              </div>
              <ChevronDown size={14} />
            </button>

            {showSwitch && (
              <div
                className="absolute right-0 top-12 z-50 w-56 overflow-hidden rounded-[var(--radius-card)] border border-border bg-white animate-fadeIn"
                style={{ boxShadow: "var(--shadow-dropdown)" }}
              >
                <p className="px-4 pb-2 pt-3 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                  Select Company
                </p>
                {companies.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setShowSwitch(false);
                      navigate(`/broker/client/${item.id}/analytics`, {
                        state: { company: item },
                      });
                    }}
                    className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-bg-page ${item.id === company.id ? "bg-[#EEF6E0]" : ""
                      }`}
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-[9px] font-semibold text-white">
                      {item.logo}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-text-primary">
                        {item.project_name || item.name}
                      </p>
                      <p className="truncate text-[10px] text-text-muted">
                        {item.industry}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
            {user?.avatar}
          </div>
        </div>
      </div>
    </header>
  );
}

export default function ClientWorkspaceLayout({ company, children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-bg-page text-text-primary">
      <div className="hidden lg:flex flex-shrink-0">
        <WorkspaceSidebar company={company} />
      </div>

      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-white/30 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative z-50 h-full w-[240px] animate-slideIn">
            <WorkspaceSidebar
              company={company}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        <WorkspaceTopbar
          company={company}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto bg-bg-page p-4 lg:p-6 scrollbar-thin">
          <div className="animate-fadeIn">{children}</div>
        </main>
      </div>
    </div>
  );
}
