import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Bell,
  Briefcase,
  Building2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FolderOpen,
  LayoutDashboard,
  Link2,
  LogOut,
  Menu,
  MoreHorizontal,
  Receipt,
  Scale,
  Users,
  X,
  BarChart3,
  Activity,
  TrendingUp,
  MessageSquare,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useMessageNotifications } from "../../context/MessageNotificationsContext";
import { listCompaniesRequest } from "../../lib/api";
import MessageNotificationsMenu from "./MessageNotificationsMenu";
import datahublogo from "../../assets/datahublogo.png";

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
  const [dataroomOpen, setDataroomOpen] = useState(true);
  const isDataroomRoute = location.pathname.includes("/dataroom/");
  const isDataroomExpanded = dataroomOpen || isDataroomRoute;

  const basePath = `/broker/client/${clientId}`;
  const mainNav = [
    // { label: "Dashboard", icon: LayoutDashboard, to: `${basePath}/dashboard` },
    {
      label: "DataHub Dashboard",
      icon: TrendingUp,
      to: `${basePath}/datahub-dashboard`,
    },
    { label: "Invoices", icon: Receipt, to: `${basePath}/invoices` },
    { label: "Reports", icon: BarChart3, to: `${basePath}/reports` },
    { label: "EBITDA", icon: Calculator, to: `${basePath}/ebitda` },
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
            alt="DataHub"
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
          onClick={() => navigate("/broker/companies")}
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
                {company.name}
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
        <div className="mb-1 flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-bg-page">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-white">
            {user?.avatar}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium leading-none text-text-primary">
              {user?.name}
            </p>
            <p className="mt-1 truncate text-[12px] leading-none text-text-muted">
              Broker
            </p>
          </div>
          <button className="text-text-muted transition-colors hover:text-text-primary">
            <MoreHorizontal size={16} />
          </button>
        </div>
        <button
          onClick={() => {
            logout();
            navigate("/login");
          }}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-[14px] font-medium text-secondary transition-colors hover:bg-red-50 hover:text-negative"
        >
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}

function WorkspaceTopbar({ company, onMenuClick }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const [showSwitch, setShowSwitch] = useState(false);
  const [companies, setCompanies] = useState([]);

  useEffect(() => {
    let cancelled = false;

    listCompaniesRequest()
      .then((data) => {
        if (!cancelled) {
          setCompanies(
            data.map((item) => ({
              ...item,
              logo: item.logo || companyLogo(item.name),
            })),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setCompanies([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const title = useMemo(() => {
    if (location.pathname.endsWith("/dashboard")) return "Dashboard";
    if (location.pathname.endsWith("/datahub-dashboard"))
      return "DataHub Dashboard";
    if (location.pathname.endsWith("/invoices")) return "Client Invoices";
    if (location.pathname.endsWith("/reports")) return "Reports";
    if (location.pathname.endsWith("/reconciliation")) return "Reconciliation";
    if (location.pathname.endsWith("/connections")) return "Connections";
    if (location.pathname.includes("/dataroom/requests"))
      return "DataRoom / Requests";
    if (location.pathname.includes("/dataroom/documents"))
      return "DataRoom / Documents";
    if (location.pathname.includes("/dataroom/users"))
      return "DataRoom / Users";
    if (location.pathname.includes("/dataroom/reminders"))
      return "DataRoom / Reminders";
    if (location.pathname.includes("/dataroom/activity"))
      return "DataRoom / Activity";
    return "Company Workspace";
  }, [location.pathname]);

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

          <div>
            <div className="flex items-center gap-2 text-sm">
              <button
                onClick={() => navigate("/broker/companies")}
                className="hidden text-[13px] font-medium text-text-muted transition-colors hover:text-text-primary sm:inline"
              >
                Companies
              </button>
              <ChevronRight
                size={14}
                className="hidden text-text-muted sm:inline"
              />
              <span className="text-[14px] font-semibold text-text-primary">
                {company.name}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-text-muted">{title}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <MessageNotificationsMenu portal="broker" companyId={company.id} />

          <div className="relative">
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
                      navigate(`/broker/client/${item.id}/datahub-dashboard`);
                    }}
                    className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-bg-page ${item.id === company.id ? "bg-[#EEF6E0]" : ""
                      }`}
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-[9px] font-semibold text-white">
                      {item.logo}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-text-primary">
                        {item.name}
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
