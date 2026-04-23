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
import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ToastProvider, useToast } from "./context/ToastContext";
import ErrorBoundary from "./components/common/ErrorBoundary";
import Layout from "./components/layout/Layout";
import ClientWorkspaceLayout from "./components/layout/ClientWorkspaceLayout";
import Login from "./pages/Login";
import BrokerDashboard from "./pages/broker/Dashboard";
import BrokerCompanies from "./pages/broker/Companies";
import BrokerRequests from "./pages/broker/Requests";
import BrokerDocuments from "./pages/broker/Documents";
import BrokerReminders from "./pages/broker/Reminders";
import ClientDashboard from "./pages/client/Dashboard";
import ClientRequests from "./pages/client/Requests";
import ClientUpload from "./pages/client/Upload";
import ClientReminders from "./pages/client/Reminders";
import WorkspaceDashboard from "./pages/broker/workspace/WorkspaceDashboard";
import WorkspaceDashboardDatahub from "./pages/broker/workspace/WorkspaceDashboardDatahub";
import WorkspaceRequests from "./pages/broker/workspace/WorkspaceRequests";
import WorkspaceDocuments from "./pages/broker/workspace/WorkspaceDocuments";
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
import { getCompanyRequest, listCompaniesRequest } from "./lib/api";

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

function ProtectedRoute({ children, allowedRole }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader message="Checking session..." />;
  if (!user) return <Navigate to="/login" replace />;
  const allowedRoles = allowedRole === "client" ? ["client", "user"] : allowedRole ? [allowedRole] : null;
  if (allowedRoles && !allowedRoles.includes(user.role))
    return (
      <Navigate
        to={user.role === "broker" ? "/broker/dashboard" : user.role === "user" ? "/client/upload" : "/client/dashboard"}
        replace
      />
    );
  return <Layout>{children}</Layout>;
}

// Wrapper for client workspace — handles auth + company resolution
function ClientWorkspaceWrapper() {
  const { user, loading: authLoading } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { clientId } = useParams();
  const [company, setCompany] = useState(location.state?.company ?? null);
  const [loading, setLoading] = useState(!location.state?.company);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user || user.role !== "broker" || !clientId) return;

    let cancelled = false;

    getCompanyRequest(clientId)
      .then((data) => {
        if (!cancelled) {
          setCompany({
            ...data,
            logo: data.logo || companyLogo(data.name),
          });
        }
      })
      .catch(async () => {
        if (cancelled) return;
        try {
          const companies = await listCompaniesRequest();
          if (cancelled) return;

          const activeCompany = companies.find(
            (entry) => String(entry.id) === String(clientId),
          );
          if (activeCompany) {
            setCompany({
              ...activeCompany,
              logo: activeCompany.logo || companyLogo(activeCompany.name),
            });
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
            navigate(`/broker/client/${fallbackCompany.id}/datahub-dashboard`, {
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
    return <Navigate to="/client/dashboard" replace />;
  if (loading) return <PageLoader message="Loading company workspace..." />;
  if (!company) return <Navigate to="/broker/companies" replace />;

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
                user.role === "broker"
                  ? "/broker/dashboard"
                  : user.role === "user"
                    ? "/client/upload"
                  : "/client/dashboard"
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
      <Route
        path="/broker/companies"
        element={
          <ProtectedRoute allowedRole="broker">
            <BrokerCompanies />
          </ProtectedRoute>
        }
      />
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

      {/* Client workspace — scoped to a specific client */}
      <Route
        path="/broker/client/:clientId"
        element={<ClientWorkspaceWrapper />}
      >
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<WorkspaceDashboard />} />
        <Route path="datahub-dashboard" element={<WorkspaceDashboardDatahub />} />
        <Route path="invoices" element={<WorkspaceInvoices />} />
        <Route path="reports" element={<WorkspaceReports />} />
        <Route path="reconciliation" element={<WorkspaceReconciliation />} />
        <Route
          path="tax-reconciliation"
          element={<WorkspaceTaxReconciliation />}
        />
        <Route path="connections" element={<WorkspaceConnections />} />
        <Route path="ebitda" element={<WorkspaceEbitda />} />
        <Route path="dataroom" element={<Navigate to="requests" replace />} />
        <Route path="dataroom/requests" element={<WorkspaceRequests />} />
        <Route path="dataroom/documents" element={<WorkspaceDocuments />} />
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
        path="/client/reminders"
        element={
          <ProtectedRoute allowedRole="client">
            <ClientReminders />
          </ProtectedRoute>
        }
      />

      <Route
        path="/support"
        element={
          <ProtectedRoute>
            <Support />
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
        <ToastProvider>
          <ErrorBoundary>
            <AppRoutes />
          </ErrorBoundary>
        </ToastProvider>
      </AuthProvider>
    </HashRouter>
  );
}
