import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useLocation,
  useParams,
  useNavigate,
} from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { MessageNotificationsProvider } from "./context/MessageNotificationsContext";
import { ToastProvider, useToast } from "./context/ToastContext";
import { DataSourceProvider } from "./context/DataSourceContext";
import ErrorBoundary from "./components/common/ErrorBoundary";
import Layout from "./components/layout/Layout";
import BrokerLayout from "./components/layout/BrokerLayout";
import ClientWorkspaceLayout from "./components/layout/ClientWorkspaceLayout";
import UserLayout from "./components/layout/UserLayout";
import Login from "./pages/Login";
import BrokerDashboard from "./pages/broker/Dashboard";
import BrokerRequests from "./pages/broker/Requests";
import BrokerDocuments from "./pages/broker/Documents";
import BrokerReminders from "./pages/broker/Reminders";
import ClientDashboard from "./pages/client/Dashboard";
import ClientRequests from "./pages/client/Requests";
import ClientUpload from "./pages/client/Upload";
import ClientReminders from "./pages/client/Reminders";
import ClientConnections from "./pages/client/Connections";
import ClientMessages from "./pages/client/Messages";
import ClientProfile from "./pages/client/Profile";
import UserPortalDashboard from "./pages/user/PortalDashboard";
import UserCompanyDetails from "./pages/user/CompanyDetails";
import UserDocuments from "./pages/user/Documents";
import UserMessages from "./pages/user/Messages";
import UserRequests from "./pages/user/Requests";
import WorkspaceDashboard from "./pages/broker/workspace/WorkspaceDashboard";
import WorkspaceDashboardDatahub from "./pages/broker/workspace/WorkspaceDashboardDatahub";
import WorkspaceRequests from "./pages/broker/workspace/WorkspaceRequests";
import WorkspaceDocuments from "./pages/broker/workspace/WorkspaceDocuments";
import WorkspaceMessages from "./pages/broker/workspace/WorkspaceMessages";
import WorkspaceReminders from "./pages/broker/workspace/WorkspaceReminders";
import WorkspaceActivity from "./pages/broker/workspace/WorkspaceActivity";
import WorkspaceUsers from "./pages/broker/workspace/WorkspaceUsers";
import WorkspaceInvoices from "./pages/broker/workspace/WorkspaceInvoices";
import WorkspaceReports from "./pages/broker/workspace/WorkspaceReports";
import WorkspaceReconciliation from "./pages/broker/workspace/WorkspaceReconciliation";
import WorkspaceTaxReconciliation from "./pages/broker/workspace/WorkspaceTaxReconciliation";
import WorkspaceConnections from "./pages/broker/workspace/WorkspaceConnections";
import Support from "./pages/Support";
import WorkspaceEbitda from "./pages/broker/workspace/WorkspaceEbitda";
import BrokerProfile from "./pages/broker/BrokerProfile";
import { getCompanyRequest, listCompaniesRequest } from "./lib/api";

function getHomeRoute(role) {
  if (role === "broker") return "/broker/dashboard";
  if (role === "user") return "/user/portal-dashboard";
  if (role === "client") return "/client/dashboard";
  return "/login";
}

function companyLogo(name = "") {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function PageLoader({ message = "Loading..." }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-page text-sm font-semibold text-secondary">
      {message}
    </div>
  );
}

function ProtectedRoute({ children, allowedRole, allowedRoles }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader message="Checking session..." />;
  if (!user) return <Navigate to="/login" replace />;
  const permittedRoles = allowedRoles || (allowedRole ? [allowedRole] : null);
  if (permittedRoles && !permittedRoles.includes(user.role))
    return (
      <Navigate
        to={getHomeRoute(user.role)}
        replace
      />
    );
  if (user.role === "user") return <UserLayout>{children}</UserLayout>;
  if (user.role === "broker") return <BrokerLayout>{children}</BrokerLayout>;
  return <Layout>{children}</Layout>;
}

// Module-level cache: clientId → resolved company object.
// Survives re-renders; cleared on full page reload.
const companyCache = {};

// Wrapper for client workspace — handles auth + company resolution
function ClientWorkspaceWrapper() {
  const { user, loading: authLoading } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { clientId } = useParams();

  // Seed from navigation state (Switch Company passes the full object) or cache.
  const seedCompany =
    (location.state?.company?.id && String(location.state.company.id) === String(clientId))
      ? location.state.company
      : companyCache[clientId] ?? null;

  const [company, setCompany] = useState(seedCompany ?? null);
  const [loading, setLoading] = useState(!seedCompany);
  const [error, setError] = useState("");

  // Keep a ref to the latest location.state so the effect can read it without
  // adding location to the dependency array (which would re-run on every nav).
  const locationStateRef = useRef(location.state);
  locationStateRef.current = location.state;

  useEffect(() => {
    if (!user || user.role !== "broker" || !clientId) return;

    // If navigation state carries the exact company for this clientId, use it
    // immediately — no network round-trip needed.
    const stateCompany = locationStateRef.current?.company;
    if (stateCompany && String(stateCompany.id) === String(clientId)) {
      const resolved = {
        ...stateCompany,
        logo: stateCompany.logo || companyLogo(stateCompany.name),
      };
      companyCache[clientId] = resolved;
      setCompany(resolved);
      setLoading(false);
      return;
    }

    // Use cache for instant render while a background refresh runs.
    if (companyCache[clientId]) {
      setCompany(companyCache[clientId]);
      setLoading(false);
    }

    let cancelled = false;

    getCompanyRequest(clientId)
      .then((data) => {
        if (!cancelled) {
          const resolved = { ...data, logo: data.logo || companyLogo(data.name) };
          companyCache[clientId] = resolved;
          setCompany(resolved);
        }
      })
      .catch(async () => {
        if (cancelled) return;
        // Already have cached data — stay silent, no spinner needed.
        if (companyCache[clientId]) return;

        try {
          const companies = await listCompaniesRequest();
          if (cancelled) return;

          const activeCompany = companies.find(
            (entry) => String(entry.id) === String(clientId),
          );
          if (activeCompany) {
            const resolved = {
              ...activeCompany,
              logo: activeCompany.logo || companyLogo(activeCompany.name),
            };
            companyCache[clientId] = resolved;
            setCompany(resolved);
            return;
          }

          if (companies.length > 0) {
            const fallbackCompany = companies[0];
            showToast({
              type: "info",
              title: "Workspace Updated",
              message:
                "That company was not found. Opened the first available company instead.",
            });
            navigate(`/broker/client/${fallbackCompany.id}/analytics`, {
              replace: true,
              state: { company: fallbackCompany },
            });
            return;
          }
        } catch {
          // fallback to default error path below
        }

        if (!cancelled) {
          setError("Unable to load company details.");
          setCompany(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, clientId, navigate, showToast]);

  useEffect(() => {
    if (!error) return;
    showToast({
      type: "error",
      title: "Workspace Notice",
      message: error,
    });
  }, [error, showToast]);

  if (authLoading) return <PageLoader message="Checking session..." />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "broker")
    return <Navigate to={getHomeRoute(user.role)} replace />;
  if (loading) return <PageLoader message="Loading company workspace..." />;
  if (!company) return <Navigate to="/broker/dashboard" replace />;

  return (
    <ClientWorkspaceLayout company={company}>
      <Outlet />
    </ClientWorkspaceLayout>
  );
}

function AppRoutes() {
  const { user, loading } = useAuth();
  return (
    <Routes>
      <Route
        path="/login"
        element={
          loading ? (
            <PageLoader message="Checking session..." />
          ) : user ? (
            <Navigate
              to={
                getHomeRoute(user.role)
              }
              replace
            />
          ) : (
            <Login />
          )
        }
      />

      {/* Broker global pages */}
      <Route
        path="/broker/dashboard"
        element={
          <ProtectedRoute allowedRole="broker">
            <BrokerDashboard />
          </ProtectedRoute>
        }
      />
      {/* /broker/companies is now merged into the dashboard */}
      <Route path="/broker/companies" element={<Navigate to="/broker/dashboard" replace />} />
      <Route
        path="/broker/requests"
        element={
          <ProtectedRoute allowedRole="broker">
            <BrokerRequests />
          </ProtectedRoute>
        }
      />
      <Route
        path="/broker/documents"
        element={
          <ProtectedRoute allowedRole="broker">
            <BrokerDocuments />
          </ProtectedRoute>
        }
      />
      <Route
        path="/broker/reminders"
        element={
          <ProtectedRoute allowedRole="broker">
            <BrokerReminders />
          </ProtectedRoute>
        }
      />
      <Route
        path="/broker/profile"
        element={
          <ProtectedRoute allowedRole="broker">
            <BrokerProfile />
          </ProtectedRoute>
        }
      />

      {/* Client workspace — scoped to a specific client */}
      <Route
        path="/broker/client/:clientId"
        element={<ClientWorkspaceWrapper />}
      >
        <Route index element={<Navigate to="analytics" replace />} />
        <Route path="analytics" element={<WorkspaceDashboardDatahub />} />
        <Route path="datahub-dashboard" element={<Navigate to="../analytics" replace />} />
        <Route path="dashboard" element={<WorkspaceDashboard />} />
        <Route path="invoices" element={<WorkspaceInvoices />} />
        <Route path="reports" element={<WorkspaceReports />} />
        <Route path="reconciliation" element={<WorkspaceReconciliation />} />
        <Route
          path="tax-reconciliation"
          element={<WorkspaceTaxReconciliation />}
        />
        <Route path="connections" element={<WorkspaceConnections />} />
        <Route path="ebitda" element={<WorkspaceEbitda />} />
        <Route path="connections" element={<WorkspaceConnections />} />
        <Route path="dataroom" element={<Navigate to="requests" replace />} />
        <Route path="dataroom/requests" element={<WorkspaceRequests />} />
        <Route path="dataroom/documents" element={<WorkspaceDocuments />} />
        <Route path="dataroom/messages" element={<WorkspaceMessages />} />
        <Route path="dataroom/reminders" element={<WorkspaceReminders />} />
        <Route path="dataroom/activity" element={<WorkspaceActivity />} />
        <Route path="dataroom/users" element={<WorkspaceUsers />} />
        <Route
          path="requests"
          element={<Navigate to="../dataroom/requests" replace />}
        />
        <Route
          path="documents"
          element={<Navigate to="../dataroom/documents" replace />}
        />
        <Route
          path="messages"
          element={<Navigate to="../dataroom/messages" replace />}
        />
        <Route
          path="reminders"
          element={<Navigate to="../dataroom/reminders" replace />}
        />
        <Route
          path="activity"
          element={<Navigate to="../dataroom/activity" replace />}
        />
        <Route
          path="users"
          element={<Navigate to="../dataroom/users" replace />}
        />
      </Route>

      {/* Client portal pages */}
      <Route
        path="/client/dashboard"
        element={
          <ProtectedRoute allowedRole="client">
            <ClientDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/client/requests"
        element={
          <ProtectedRoute allowedRole="client">
            <ClientRequests />
          </ProtectedRoute>
        }
      />
      <Route
        path="/client/upload"
        element={
          <ProtectedRoute allowedRole="client">
            <ClientUpload />
          </ProtectedRoute>
        }
      />
      <Route
        path="/client/documents"
        element={
          <ProtectedRoute allowedRole="client">
            <Navigate to="/client/upload" replace />
          </ProtectedRoute>
        }
      />
      <Route
        path="/client/messages"
        element={
          <ProtectedRoute allowedRole="client">
            <ClientMessages />
          </ProtectedRoute>
        }
      />
      <Route
        path="/client/reminders"
        element={
          <ProtectedRoute allowedRole="client">
            <ClientReminders />
          </ProtectedRoute>
        }
      />
      <Route
        path="/client/profile"
        element={
          <ProtectedRoute allowedRole="client">
            <ClientProfile />
          </ProtectedRoute>
        }
      />

      <Route path="/user/dashboard" element={<Navigate to="/user/portal-dashboard" replace />} />
      <Route
        path="/user/portal-dashboard"
        element={
          <ProtectedRoute allowedRole="user">
            <UserPortalDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/user/company/:clientId"
        element={
          <ProtectedRoute allowedRole="user">
            <UserCompanyDetails />
          </ProtectedRoute>
        }
      />
      <Route
        path="/user/documents"
        element={
          <ProtectedRoute allowedRole="user">
            <UserDocuments />
          </ProtectedRoute>
        }
      />
      <Route
        path="/user/requests"
        element={
          <ProtectedRoute allowedRole="user">
            <UserRequests />
          </ProtectedRoute>
        }
      />
      <Route
        path="/user/messages"
        element={
          <ProtectedRoute allowedRole="user">
            <UserMessages />
          </ProtectedRoute>
        }
      />

      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <MessageNotificationsProvider>
          <ToastProvider>
            <DataSourceProvider>
              <ErrorBoundary>
                <AppRoutes />
              </ErrorBoundary>
            </DataSourceProvider>
          </ToastProvider>
        </MessageNotificationsProvider>
      </AuthProvider>
    </HashRouter>
  );
}
