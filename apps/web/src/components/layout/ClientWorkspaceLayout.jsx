import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Bell,
  Building2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FolderOpen,
  Link2,
  LogOut,
  Menu,
  MoreHorizontal,
  Receipt,
  Scale,
  Search,
  Settings,
  Users,
  X,
  BarChart3,
  TrendingUp,
  MessageSquare,
  MessageSquareText,
  BookOpen,
  Calculator,
  FileCheck,
  FileText,
  Target,
} from "lucide-react";
import { useFeature } from "../../context/useFeature";
import { useAuth } from "../../context/AuthContext";
import { useMessageNotifications } from "../../context/MessageNotificationsContext";
import { listCompaniesRequest } from "../../lib/api";
import { getProfitMetricConfig } from "../../lib/profitMetric";
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

function NavItem({ item, onClose, companyMessageCount }) {
  const Icon = item.icon;
  return (
    <NavLink
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
          <Icon size={18} className={isActive ? "text-primary" : "text-text-muted"} />
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
}

function NavFolder({ folder, onClose, companyMessageCount, location }) {
  const hasActiveChild = folder.children.some((c) => location.pathname === c.to || location.pathname.startsWith(c.to + '/'));
  const [open, setOpen] = useState(hasActiveChild);
  const Icon = folder.icon;

  // Auto-open when a child becomes active (e.g. navigating via URL)
  useEffect(() => {
    if (hasActiveChild) setOpen(true);
  }, [hasActiveChild]);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`relative flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-[14px] font-medium transition-all duration-200 ${hasActiveChild
            ? "text-primary"
            : "text-secondary hover:bg-[#F0F7E6] hover:text-text-primary"
          }`}
      >
        {hasActiveChild && (
          <div className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
        )}
        <Icon size={18} className={hasActiveChild ? "text-primary" : "text-text-muted"} />
        <span className="flex-1 text-left">{folder.label}</span>
        <ChevronRight
          size={14}
          className={`flex-shrink-0 text-text-muted transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
      </button>

      {open && (
        <div className="ml-3 mt-0.5 space-y-0.5 border-l-2 border-border pl-3">
          {folder.children.map((child) => (
            <NavItem key={child.to} item={child} onClose={onClose} companyMessageCount={companyMessageCount} />
          ))}
        </div>
      )}
    </div>
  );
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

  const basePath = `/broker/client/${clientId}`;
  const qaEnabled = useFeature("qa");
  const cimEnabled = useFeature("cim");
  const qoeEnabled = useFeature("qoe");

  const profitMetricConfig = getProfitMetricConfig(company);

  /**
   * The workspace navigation, organised around what a broker is actually doing.
   *
   * It used to be eleven top-level destinations, TEN of which were financial
   * tooling: Key Reports, Financial Reports, Analytics, Invoices, the earnings
   * bridge, a Quality of Earnings folder with three children of its own, and
   * Connections. The four things this product is for — the data room, the
   * requests and questions, the CIM, and a view of the numbers — shared the
   * remaining space with a module that bills the client. The shape of the
   * sidebar said "accounting platform" before a single screen loaded.
   *
   * Nothing has been deleted and NO URL has changed. Every route still resolves
   * exactly where it did, so bookmarks, deep links and anything a broker has
   * pinned keep working. What changed is which things are peers: the financial
   * screens are now children of one destination rather than nine siblings of the
   * data room.
   *
   * Feature flags behave as before — a disabled capability is omitted entirely
   * rather than greyed out, because a control the user can click and get nothing
   * from is worse than one they cannot see.
   */
  const navStructure = [
    { label: "Overview", icon: Target, to: `${basePath}/dataroom/deal-tracker` },

    // ── Pillar 1 — the data room ────────────────────────────────────────────
    {
      type: 'folder',
      label: "Dataroom",
      icon: FolderOpen,
      children: [
        { label: "Documents", icon: FileText, to: `${basePath}/dataroom/documents` },
        { label: "Activity", icon: TrendingUp, to: `${basePath}/dataroom/activity` },
      ],
    },

    // ── Pillar 2 — what is outstanding ──────────────────────────────────────
    // Requests and questions are the same job: chasing the seller for something,
    // differing only in whether the answer is a file or a sentence. They were
    // siblings that never referred to each other.
    {
      type: 'folder',
      label: "Requests & Q&A",
      icon: ClipboardList,
      children: [
        { label: "Requests", icon: ClipboardList, to: `${basePath}/dataroom/requests` },
        ...(qaEnabled
          ? [{ label: "Questions", icon: MessageSquareText, to: `${basePath}/dataroom/qa` }]
          : []),
        { label: "Reminders", icon: Bell, to: `${basePath}/dataroom/reminders` },
      ],
    },

    // ── Pillar 3 — the CIM ──────────────────────────────────────────────────
    // One destination, two surfaces. CIM Prep is the PowerPoint path and stays
    // (cim-builder/design.md D-49 records that decision); it is no longer a
    // top-level peer of the builder, which made the product look like it shipped
    // two unrelated CIM tools and left the reader to guess which was real.
    ...(cimEnabled
      ? [{
          type: 'folder',
          label: "CIM",
          icon: BookOpen,
          children: [
            { label: "Builder", icon: BookOpen, to: `${basePath}/dataroom/cim` },
            { label: "Slide deck", icon: FileText, to: `${basePath}/cim-prep` },
          ],
        }]
      : [{ label: "CIM Prep", icon: BookOpen, to: `${basePath}/cim-prep` }]),

    // ── Pillar 4 — the numbers ──────────────────────────────────────────────
    // Nine destinations become one with children. Statements first because it is
    // the one that works and was buried two levels down, under a page that
    // cannot produce a statement.
    {
      type: 'folder',
      label: "Financials",
      icon: BarChart3,
      children: [
        ...(qoeEnabled
          ? [
              { label: "Statements", icon: BarChart3, to: `${basePath}/statements` },
              { label: profitMetricConfig.navLabel, icon: Calculator, to: `${basePath}/ebitda` },
            ]
          : []),
        { label: "Key Reports", icon: FileCheck, to: `${basePath}/dataroom/key-reports` },
        { label: "Reports", icon: BarChart3, to: `${basePath}/reports` },
        { label: "Analytics", icon: TrendingUp, to: `${basePath}/analytics` },
        { label: "Bank Reconciliation", icon: Scale, to: `${basePath}/reconciliation` },
        { label: "Tax Reconciliation", icon: FileCheck, to: `${basePath}/tax-reconciliation` },
        // Billing the client is not part of running their deal. It belongs in a
        // firm-level area, which does not exist yet — parked here rather than
        // made unreachable. See broker-surface-remediation §7.2.
        { label: "Invoices", icon: Receipt, to: `${basePath}/invoices` },
      ],
    },

    { label: "Messages", icon: MessageSquare, to: `${basePath}/dataroom/messages` },
    { label: "People", icon: Users, to: `${basePath}/dataroom/users` },
    // Configuration, not a place you work. Last, where settings live.
    { label: "Connections", icon: Link2, to: `${basePath}/connections` },
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
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-secondary transition-colors hover:bg-bg-page hover:text-text-primary"
        >
          <ArrowLeft size={13} />
          All Companies
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-0.5">
          {navStructure.map((item) =>
            item.type === 'folder' ? (
              <NavFolder
                key={item.label}
                folder={item}
                onClose={onClose}
                companyMessageCount={companyMessageCount}
                location={location}
              />
            ) : (
              <NavItem
                key={item.to}
                item={item}
                onClose={onClose}
                companyMessageCount={companyMessageCount}
              />
            )
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
              <button
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-negative transition-colors hover:bg-red-50"
                onClick={() => {
                  setShowUserMenu(false);
                  setShowLogoutConfirm(true);
                }}
              >
                <LogOut size={14} />
                Sign Out
              </button>
            </div>
          )}
          <button
            onClick={() => setShowUserMenu((v) => !v)}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-bg-page"
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
  const [search, setSearch] = useState('');
  const switchRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    if (!showSwitch) { setSearch(''); return undefined; }

    const handleOutsideClick = (event) => {
      if (switchRef.current && !switchRef.current.contains(event.target)) {
        setShowSwitch(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);
    // Focus search after open animation
    const t = setTimeout(() => searchRef.current?.focus(), 50);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
      clearTimeout(t);
    };
  }, [showSwitch]);

  useEffect(() => {
    if (cachedSwitchCompanies) return;
    let cancelled = false;
    listCompaniesRequest()
      .then((data) => {
        if (!cancelled) {
          const mapped = data.map((item) => ({ ...item, logo: item.logo || companyLogo(item.name) }));
          cachedSwitchCompanies = mapped;
          setCompanies(mapped);
        }
      })
      .catch(() => { if (!cancelled) setCompanies([]); });
    return () => { cancelled = true; };
  }, []);

  const filteredCompanies = search.trim()
    ? companies.filter((c) => {
      const q = search.toLowerCase();
      return (
        (c.name || '').toLowerCase().includes(q) ||
        (c.project_name || '').toLowerCase().includes(q) ||
        (c.industry || '').toLowerCase().includes(q)
      );
    })
    : companies;

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg-card">
      <div className="flex items-center justify-between px-4 py-3 lg:px-6">
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

          {/* Company overview card / switcher */}
          <div className="relative" ref={switchRef}>
            <button
              onClick={() => setShowSwitch((v) => !v)}
              className={`flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition-all hover:shadow-md active:scale-[0.98] ${showSwitch ? 'border-primary/40 bg-[#EEF6E0] shadow-sm' : 'border-border bg-bg-card hover:border-primary/30'
                }`}
              style={{ width: 260 }}
            >
              {/* Logo avatar */}
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary text-[11px] font-bold text-white shadow-sm">
                {company.logo || companyLogo(company.name)}
              </div>

              {/* Company info */}
              <div className="hidden min-w-0 flex-1 sm:block">
                <p className="max-w-[160px] truncate text-[13px] font-semibold text-text-primary leading-tight">
                  {company.name}
                </p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {company.project_name && (
                    <span className="truncate text-[11px] text-text-muted max-w-[100px]">
                      {company.project_name}
                    </span>
                  )}
                  {company.project_name && company.industry && (
                    <span className="text-[10px] text-text-muted opacity-40">·</span>
                  )}
                  {company.industry && (
                    <span className="truncate text-[11px] text-primary/70 max-w-[100px]">
                      {company.industry}
                    </span>
                  )}
                </div>
              </div>

              <ChevronDown
                size={14}
                className={`ml-auto flex-shrink-0 text-text-muted transition-transform duration-200 ${showSwitch ? 'rotate-180' : ''}`}
              />
            </button>

            {showSwitch && (
              <div
                className="absolute right-0 top-[calc(100%+8px)] z-50 w-80 rounded-xl border border-border bg-white animate-fadeIn overflow-hidden"
                style={{ boxShadow: '0 8px 30px rgba(0,0,0,0.12)' }}
              >
                {/* Header */}
                <div className="px-4 pt-3 pb-2 border-b border-border/60">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-2">
                    Switch Company
                  </p>
                  {/* Search */}
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-page px-3 py-1.5">
                    <Search size={13} className="flex-shrink-0 text-text-muted" />
                    <input
                      ref={searchRef}
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search companies…"
                      className="flex-1 bg-transparent text-[13px] text-text-primary placeholder-text-muted outline-none"
                    />
                    {search && (
                      <button onClick={() => setSearch('')} className="text-text-muted hover:text-text-primary">
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Company list */}
                <div className="overflow-y-auto" style={{ maxHeight: 340 }}>
                  {filteredCompanies.length === 0 ? (
                    <div className="px-4 py-8 text-center">
                      <Building2 size={24} className="mx-auto mb-2 text-text-muted opacity-40" />
                      <p className="text-[13px] text-text-muted">No companies found</p>
                    </div>
                  ) : (
                    filteredCompanies.map((item) => {
                      const isActive = item.id === company.id;
                      return (
                        <button
                          key={item.id}
                          onClick={() => {
                            setShowSwitch(false);
                            navigate(`/broker/client/${item.id}/dataroom/deal-tracker`, { state: { company: item } });
                          }}
                          className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors border-b border-border/40 last:border-0 ${isActive ? 'bg-[#EEF6E0]' : 'hover:bg-bg-page'
                            }`}
                        >
                          <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white shadow-sm ${isActive ? 'bg-primary' : 'bg-[#8896B0]'}`}>
                            {item.logo}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={`truncate text-[13px] font-semibold leading-tight ${isActive ? 'text-primary' : 'text-text-primary'}`}>
                              {item.name}
                            </p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              {item.project_name && (
                                <span className="truncate text-[11px] text-text-muted">
                                  {item.project_name}
                                </span>
                              )}
                              {item.project_name && item.industry && (
                                <span className="text-[10px] text-text-muted opacity-40">·</span>
                              )}
                              {item.industry && (
                                <span className="truncate text-[11px] text-primary/60">
                                  {item.industry}
                                </span>
                              )}
                            </div>
                          </div>
                          {isActive && (
                            <div className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-primary" />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
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
