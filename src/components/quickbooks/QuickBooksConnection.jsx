import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Database,
  Link2Off,
  Loader2,
  RefreshCw,
  Shield,
  Zap,
} from "lucide-react";
import {
  connectQuickbooks,
  disconnectQuickbooks,
  fetchBalanceSheet,
  fetchProfitAndLoss,
  getConnectionStatus,
  refreshQuickbooksToken,
  syncGeneralLedger,
} from "../../lib/quickbooks";
import { useToast } from "../../context/ToastContext";
import { fetchCustomers } from "../../services/customerService";
import { fetchInvoices } from "../../services/invoiceService";
import { cn } from "../../lib/utils";
import QBDisconnectedBanner from "../common/QBDisconnectedBanner";

// ─── Helpers ────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getTimeLeft(dateStr) {
  if (!dateStr) return "—";
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} Min Left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} Hours Left`;
  const days = Math.floor(hours / 24);
  return `${days} Days Left`;
}

// ─── Component ──────────────────────────────────────────

export default function QuickBooksConnection({ company }) {
  const location = useLocation();
  const { showToast } = useToast();

  const [connection, setConnection] = useState(null);
  const [pageState, setPageState] = useState("loading");
  const [errorMessage, setErrorMessage] = useState(null);
  const [dynamicEntities, setDynamicEntities] = useState(null);

  const [isSyncing, setIsSyncing] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);

  // Handle OAuth callback query params
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const qbStatus = params.get("qbStatus");
    const qbMessage = params.get("qbMessage");
    if (qbStatus === "success") {
      showToast({
        type: "success",
        title: "Connection Updated",
        message: "QuickBooks connected successfully.",
      });
    }
    if (qbStatus === "error") {
      showToast({
        type: "error",
        title: "Connection Notice",
        message: qbMessage || "QuickBooks connection could not be completed.",
      });
      setErrorMessage(
        qbMessage || "QuickBooks connection could not be completed.",
      );
    }
  }, [location.search, showToast]);

  // Fetch real connection status from backend
  const fetchStatus = useCallback(
    async (showLoader = true) => {
      if (showLoader) setPageState("loading");
      setErrorMessage(null);
      try {
        const data = await getConnectionStatus();
        setConnection(data);

        if (data?.isNameMismatch) {
          setDynamicEntities(null);
          setPageState("disconnected");
          setErrorMessage(
            data.message ||
            "The selected workspace company does not match the connected QuickBooks company.",
          );
          return;
        }

        setPageState(data.isConnected ? "connected" : "disconnected");

        if (data.isConnected) {
          Promise.all([
            fetchCustomers().catch(() => ({})),
            fetchInvoices().catch(() => ({})),
            fetchBalanceSheet().catch(() => ({})),
            fetchProfitAndLoss().catch(() => ({})),
            syncGeneralLedger().catch(() => ({})),
          ]).then(([customersRes, invoicesRes, bsRes, pnlRes, glRes]) => {
            const custs = Array.isArray(customersRes?.QueryResponse?.Customer)
              ? customersRes.QueryResponse.Customer
              : Array.isArray(customersRes?.data?.QueryResponse?.Customer)
                ? customersRes.data.QueryResponse.Customer
                : Array.isArray(customersRes)
                  ? customersRes
                  : [];

            const invs = Array.isArray(invoicesRes?.QueryResponse?.Invoice)
              ? invoicesRes.QueryResponse.Invoice
              : Array.isArray(invoicesRes?.data?.QueryResponse?.Invoice)
                ? invoicesRes.data.QueryResponse.Invoice
                : Array.isArray(invoicesRes)
                  ? invoicesRes
                  : [];

            // Helper to count rows in QB reports
            const countReportRows = (res) => {
              const rows = res?.Rows?.Row || res?.data?.Rows?.Row || res?.data?.data?.Rows?.Row || [];
              return Array.isArray(rows) ? rows.length : 0;
            };

            setDynamicEntities([
              {
                name: "Customers",
                count: custs.length,
                lastSync: data.lastSynced,
                status: "synced",
              },
              {
                name: "Invoices",
                count: invs.length,
                lastSync: data.lastSynced,
                status: "synced",
              },
              {
                name: "Profit and Loss",
                count: countReportRows(pnlRes),
                lastSync: data.lastSynced,
                status: "synced",
              },
              {
                name: "Balance Sheet",
                count: countReportRows(bsRes),
                lastSync: data.lastSynced,
                status: "synced",
              },
              {
                name: "General Ledger",
                count: glRes?.totalInserted || glRes?.data?.totalInserted || 0,
                lastSync: data.lastSynced,
                status: "synced",
              },
            ]);
          });
        }
      } catch (err) {
        console.error("Failed to fetch connection status:", err);
        setConnection(null);
        setPageState("error");
        setErrorMessage(
          err instanceof Error
            ? err.message
            : "Could not reach the backend. Is it running?",
        );
      }
    },
    [company],
  );

  useEffect(() => {
    fetchStatus(true);
  }, [fetchStatus]);

  // ── Actions ──
  const handleConnect = () => connectQuickbooks(location.pathname, company?.id);

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      await disconnectQuickbooks();
      setShowDisconnectModal(false);

      // Immediately reset local state for better UI responsiveness
      setConnection(null);
      setPageState("disconnected");
      setDynamicEntities(null);
      setErrorMessage(null);

      showToast({
        type: "success",
        title: "Disconnected",
        message: "QuickBooks disconnected successfully.",
      });

      // Refresh status just in case
      await fetchStatus(false);
    } catch (err) {
      console.error("Disconnect failed:", err);
      setErrorMessage("Failed to disconnect. Please try again.");
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleSync = async () => {
    setIsSyncing(true);
    setErrorMessage(null);
    try {
      await refreshQuickbooksToken();
      showToast({
        type: "success",
        title: "Token Refreshed",
        message: "QuickBooks token refreshed successfully.",
      });
      await fetchStatus(false);
    } catch (err) {
      console.error("Sync failed:", err);
      setErrorMessage(
        "Token refresh failed. Your session may have expired — try reconnecting.",
      );
    } finally {
      setIsSyncing(false);
    }
  };

  // ── Derived values ──
  const tokenTimeLeft = connection?.tokenExpiresAt
    ? getTimeLeft(connection.tokenExpiresAt)
    : "—";
  const isTokenExpired = tokenTimeLeft === "Expired";
  const activeEntities =
    (dynamicEntities ||
      (connection?.syncedEntities || []).map((e) =>
        typeof e === "string"
          ? {
            name: e,
            count: "—",
            lastSync: connection?.lastSynced,
            status: "synced",
          }
          : e,
      )) ||
    [];
  const totalSyncedRecords = useMemo(
    () => activeEntities.reduce((sum, e) => sum + Number(e.count || 0), 0),
    [activeEntities],
  );

  // ────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <QBDisconnectedBanner pageName="Connections" />

      {/* Error Banner */}
      {errorMessage && pageState !== "loading" && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-[#C62026]/30 bg-[#fef2f2] text-[#C62026] text-[13px]">
          <AlertCircle size={16} className="shrink-0" />
          <span>{errorMessage}</span>
          {(errorMessage.toLowerCase().includes("expired") ||
            errorMessage.toLowerCase().includes("disconnect")) && (
              <button
                onClick={handleConnect}
                className="ml-auto flex items-center gap-1 font-bold underline hover:opacity-80 transition-opacity"
              >
                <Zap size={14} /> Reconnect
              </button>
            )}
          <button
            onClick={() => setErrorMessage(null)}
            className={cn(
              "text-[#C62026]/60 hover:text-[#C62026] transition-colors font-bold",
              errorMessage.toLowerCase().includes("expired") ||
                errorMessage.toLowerCase().includes("disconnect")
                ? "ml-4"
                : "ml-auto",
            )}
          >
            ✕
          </button>
        </div>
      )}

      {/* Token Expired Banner */}
      {pageState === "connected" && isTokenExpired && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-yellow-300/50 bg-yellow-50 text-[13px]">
          <AlertCircle size={16} className="shrink-0 text-yellow-700" />
          <span className="text-yellow-700 font-medium">
            Your QuickBooks session has expired. Automatic sync is paused
            until you reconnect.
          </span>
          <button
            onClick={handleConnect}
            className="ml-auto flex items-center gap-1 font-bold underline text-yellow-700 hover:text-yellow-800 transition-colors"
          >
            <Zap size={14} /> Reconnect to QuickBooks
          </button>
        </div>
      )}

      {/* ─── Main Status Card ──────────────────────────── */}
      <div className="card-base overflow-hidden">
        {/* Status Bar */}
        <div
          className={cn(
            "px-6 py-3 flex items-center justify-between border-b-2",
            pageState === "connected"
              ? "bg-[#8bc53d]/10 border-[#8bc53d]"
              : "bg-bg-page border-border",
          )}
        >
          <div className="flex items-center gap-2">
            {pageState === "loading" && (
              <Loader2 size={16} className="text-text-muted animate-spin" />
            )}
            {pageState === "connected" && (
              <CheckCircle2 size={16} className="text-primary" />
            )}
            {pageState === "disconnected" && (
              <Link2Off size={16} className="text-text-secondary" />
            )}
            {pageState === "error" && (
              <AlertCircle size={16} className="text-[#C62026]" />
            )}
            <span
              className={cn(
                "text-[14px] font-semibold",
                pageState === "connected" && "text-primary",
                pageState === "disconnected" && "text-text-secondary",
                pageState === "loading" && "text-text-muted",
                pageState === "error" && "text-[#C62026]",
              )}
            >
              {pageState === "loading" && "Checking connection..."}
              {pageState === "connected" && "Connected"}
              {pageState === "disconnected" && "Disconnected"}
              {pageState === "error" && "Connection Error"}
            </span>
          </div>
          {pageState === "connected" &&
            connection?.lastSynced && (
              <span className="text-[12px] text-text-muted">
                Last synced: {timeAgo(connection.lastSynced)}
              </span>
            )}
        </div>

        {/* Card Body */}
        <div className="p-6">
          {/* Loading */}
          {pageState === "loading" && (
            <div className="space-y-4">
              <div className="skeleton h-12 w-64 rounded-md" />
              <div className="skeleton h-4 w-48 rounded-md" />
              <div className="skeleton h-4 w-36 rounded-md" />
            </div>
          )}

          {/* Connected */}
          {pageState === "connected" && connection && (
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-5">
                <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-primary text-white font-bold text-xl shrink-0">
                  QB
                </div>
                <div>
                  <h3 className="text-[18px] font-semibold text-text-primary">
                    QuickBooks Online
                  </h3>
                  <p className="text-[14px] text-text-secondary mb-3">
                    {connection.companyName ||
                      company?.name ||
                      "Connected Company"}
                  </p>
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    {connection.companyId && (
                      <div className="flex items-center gap-1.5 text-[12px] text-text-muted">
                        <Database size={13} /> Company ID:{" "}
                        <span className="font-medium text-text-secondary">
                          {connection.companyId}
                        </span>
                      </div>
                    )}
                    {connection.environment && (
                      <div className="flex items-center gap-1.5 text-[12px] text-text-muted">
                        <Shield size={13} /> Environment:{" "}
                        <span className="font-semibold text-primary capitalize">
                          {connection.environment}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSync}
                  disabled={isSyncing}
                  className="btn-primary"
                >
                  <RefreshCw
                    size={16}
                    className={isSyncing ? "animate-spin" : ""}
                  />
                  {isSyncing ? "Syncing..." : "Sync Now"}
                </button>
                <button
                  onClick={() => setShowDisconnectModal(true)}
                  className="btn-negative"
                >
                  Disconnect
                </button>
              </div>
            </div>
          )}

          {/* Disconnected */}
          {pageState === "disconnected" && (
            <div className="text-center py-8">
              <div className="w-16 h-16 rounded-xl bg-bg-page mx-auto mb-4 flex items-center justify-center text-text-muted">
                <Link2Off size={32} />
              </div>
              <h3 className="text-[18px] font-semibold text-text-primary mb-2">
                No active connection
              </h3>
              <p className="text-[14px] text-text-secondary mb-6 max-w-sm mx-auto">
                Connect your QuickBooks account to start syncing your
                financial data automatically.
              </p>
              <button
                onClick={handleConnect}
                className="btn-primary h-11 px-8 shadow-md mx-auto"
              >
                <Zap size={16} /> Connect to QuickBooks
              </button>
            </div>
          )}

          {/* Error */}
          {pageState === "error" && (
            <div className="text-center py-8">
              <div className="w-16 h-16 rounded-xl bg-[#fef2f2] mx-auto mb-4 flex items-center justify-center text-[#C62026]">
                <AlertCircle size={32} />
              </div>
              <h3 className="text-[18px] font-semibold text-text-primary mb-2">
                Unable to check connection
              </h3>
              <p className="text-[14px] text-text-secondary mb-6 max-w-sm mx-auto">
                {errorMessage ||
                  "Could not reach the backend server. Make sure it is running."}
              </p>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => fetchStatus(true)}
                  className="btn-primary h-10 px-6"
                >
                  <RefreshCw size={16} /> Retry
                </button>
                <button
                  onClick={handleConnect}
                  className="btn-secondary h-10 px-6"
                >
                  <Zap size={16} /> Reconnect
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Info Grid (only when connected) ───────────── */}
      {pageState === "connected" && connection && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Access Token */}
            <div className="card-base p-5">
              <div className="flex items-center gap-2 mb-3 text-text-muted text-[12px] font-medium">
                <Shield size={14} className="text-primary" /> Access Token
              </div>
              <p className="text-[24px] font-bold text-text-primary">
                Active
              </p>
              <p className="text-[12px] text-text-muted mt-1">
                Refreshed automatically
              </p>
            </div>

            {/* Token Expiry */}
            <div className="card-base p-5 border-l-4 border-l-yellow-400">
              <div className="flex items-center gap-2 mb-3 text-text-muted text-[12px] font-medium">
                <Clock size={14} className="text-yellow-500" /> Token Expiry
              </div>
              {connection.tokenExpiresAt ? (
                <>
                  <p className="text-[24px] font-bold text-yellow-600">
                    {tokenTimeLeft}
                  </p>
                  <p className="text-[12px] text-text-muted mt-1">
                    Valid until {formatDate(connection.tokenExpiresAt)}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[24px] font-bold text-yellow-600">
                    ~60 min
                  </p>
                  <p className="text-[12px] text-text-muted mt-1">
                    Access tokens expire after ~1 hour
                  </p>
                </>
              )}
            </div>

            {/* Records Synced */}
            <div className="card-base p-5">
              <div className="flex items-center gap-2 mb-3 text-text-muted text-[12px] font-medium">
                <Database size={14} className="text-[#00648F]" /> Records
                Synced
              </div>
              <p className="text-[24px] font-bold text-text-primary">
                {totalSyncedRecords > 0
                  ? totalSyncedRecords.toLocaleString()
                  : "—"}
              </p>
              <p className="text-[12px] text-text-muted mt-1">
                {totalSyncedRecords > 0
                  ? "Total synchronized entries"
                  : "Sync data not available yet"}
              </p>
            </div>
          </div>

          {/* ─── Synced Entities Table ─────────────────── */}
          {activeEntities.length > 0 && (
            <div className="card-base overflow-hidden">
              <div className="px-6 py-4 border-b border-border">
                <h3 className="text-[16px] font-semibold text-text-primary">
                  Synced Entities
                </h3>
              </div>
              <div className="divide-y divide-border">
                {activeEntities.map((entity, i) => (
                  <div
                    key={i}
                    className="px-6 py-3 flex items-center justify-between hover:bg-bg-page/50 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-9 h-9 rounded-md bg-bg-page flex items-center justify-center text-text-secondary">
                        <Database size={18} />
                      </div>
                      <div>
                        <p className="text-[14px] font-medium text-text-primary">
                          {entity.name}
                        </p>
                        <p className="text-[12px] text-text-muted">
                          {entity.lastSync
                            ? `Last sync ${timeAgo(entity.lastSync)}`
                            : "Not synced yet"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-6">
                      <div className="text-right">
                        <p className="text-[14px] font-semibold text-text-primary">
                          {entity.count}
                        </p>
                        <p className="text-[11px] text-text-muted uppercase">
                          Entities
                        </p>
                      </div>
                      <span
                        className={cn(
                          "text-[11px] font-semibold px-2.5 py-1 rounded-full",
                          entity.status === "synced" &&
                          "bg-[#8bc53d]/20 text-[#476E2C]",
                          entity.status === "syncing" &&
                          "bg-yellow-50 text-yellow-700",
                          entity.status === "error" &&
                          "bg-[#fef2f2] text-[#C62026]",
                        )}
                      >
                        {entity.status === "synced" && "Synced"}
                        {entity.status === "syncing" && "Syncing..."}
                        {entity.status === "error" && "Error"}
                      </span>
                      <ChevronRight size={16} className="text-text-muted" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ─── Connection Details ────────────────────── */}
          <div className="card-base p-6">
            <h3 className="text-[16px] font-semibold text-text-primary mb-5">
              Connection Details
            </h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-4">
              {company?.name && (
                <p className="text-[14px] font-medium text-text-primary">
                  {company.name}
                </p>
              )}
              {connection.connectedAt && (
                <div>
                  <p className="text-[12px] text-text-muted font-medium uppercase tracking-wider mb-1">
                    Connected Since
                  </p>
                  <p className="text-[14px] text-text-primary font-medium">
                    {formatDate(connection.connectedAt)}
                  </p>
                </div>
              )}
              {connection.lastSynced && (
                <div>
                  <p className="text-[12px] text-text-muted font-medium uppercase tracking-wider mb-1">
                    Last Data Sync
                  </p>
                  <p className="text-[14px] text-text-primary font-medium">
                    {formatDate(connection.lastSynced)}
                  </p>
                </div>
              )}
              {connection.companyId && (
                <div>
                  <p className="text-[14px] text-text-primary font-medium font-mono">
                    {connection.companyId}
                  </p>
                </div>
              )}
              {connection.environment && (
                <div>
                  <p className="text-[12px] text-text-muted font-medium uppercase tracking-wider mb-1">
                    Environment
                  </p>
                  <p className="text-[14px] text-primary font-semibold capitalize">
                    {connection.environment}
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ─── Disconnect Confirmation Modal ──────────────── */}
      {showDisconnectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => !isDisconnecting && setShowDisconnectModal(false)}
          />
          <div className="relative bg-bg-card rounded-xl border border-border w-full max-w-md p-6 shadow-2xl">
            <div className="w-12 h-12 bg-[#fef2f2] rounded-full flex items-center justify-center mx-auto mb-4 text-[#C62026]">
              <AlertCircle size={24} />
            </div>
            <h3 className="text-[18px] font-semibold text-center text-text-primary mb-2">
              Disconnect QuickBooks?
            </h3>
            <p className="text-[14px] text-text-secondary text-center leading-relaxed">
              This will stop all automatic syncing and revoke active tokens.
              Your existing data will remain as-is.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowDisconnectModal(false)}
                disabled={isDisconnecting}
                className="flex-1 h-10 rounded-md border border-border font-medium text-[14px] hover:bg-bg-page transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDisconnect}
                disabled={isDisconnecting}
                className="flex-1 h-10 rounded-md bg-[#C62026] text-white font-semibold text-[14px] hover:bg-[#9f1b20] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isDisconnecting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />{" "}
                    Disconnecting...
                  </>
                ) : (
                  "Disconnect"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
