import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Link2, RefreshCw, ShieldAlert, Unplug } from 'lucide-react';
import { connectQuickbooks, disconnectQuickbooks, getConnectionStatus, refreshQuickbooksToken } from '../../../lib/quickbooks';
import { getCompanyRequest } from '../../../lib/api';
import { useToast } from '../../../context/ToastContext';

export default function WorkspaceConnections() {
  const location = useLocation();
  const { clientId } = useParams();
  const { showToast } = useToast();
  const [company, setCompany] = useState(null);
  const [status, setStatus] = useState({ isConnected: false, syncedEntities: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    getCompanyRequest(clientId).then(setCompany).catch(() => setCompany(null));
  }, [clientId]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const qbStatus = params.get('qbStatus');
    const qbMessage = params.get('qbMessage');
    if (qbStatus === 'success') setFeedback('QuickBooks connected successfully.');
    if (qbStatus === 'error') setFeedback(qbMessage || 'QuickBooks connection could not be completed.');
  }, [location.search]);

  useEffect(() => {
    if (!feedback) return;
    showToast({
      type: status.isConnected ? 'success' : 'error',
      title: status.isConnected ? 'Connection Updated' : 'Connection Notice',
      message: feedback,
    });
  }, [feedback, showToast, status.isConnected]);

  const loadStatus = async () => {
    setLoading(true);
    try {
      const nextStatus = await getConnectionStatus();
      setStatus(nextStatus);
    } catch (error) {
      setFeedback(error.message || 'Unable to fetch connection status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const summaryCards = useMemo(() => [
    {
      label: 'Workspace Company',
      value: company?.name || 'Loading...',
    },
    {
      label: 'Connection Status',
      value: status.isConnected ? 'Connected' : 'Disconnected',
    },
    {
      label: 'Environment',
      value: status.environment || 'Not available',
    },
    {
      label: 'Last Synced',
      value: status.lastSynced ? new Date(status.lastSynced).toLocaleString() : 'Not synced yet',
    },
  ], [company?.name, status.environment, status.isConnected, status.lastSynced]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Connections</h1>
          <p className="mt-0.5 text-sm text-[#6D6E71]">Manage QuickBooks connectivity for the selected company workspace.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              setBusy('refresh');
              try {
                await refreshQuickbooksToken();
                await loadStatus();
                setFeedback('QuickBooks token refreshed.');
              } catch (error) {
                setFeedback(error.message || 'Token refresh failed.');
              } finally {
                setBusy('');
              }
            }}
            className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-[#050505] shadow-sm transition-all hover:bg-gray-50"
          >
            <RefreshCw size={15} className={busy === 'refresh' ? 'animate-spin' : ''} />
            Refresh
          </button>
          {status.isConnected ? (
            <button
              onClick={async () => {
                setBusy('disconnect');
                try {
                  await disconnectQuickbooks();
                  await loadStatus();
                  setFeedback('QuickBooks disconnected.');
                } catch (error) {
                  setFeedback(error.message || 'Disconnect failed.');
                } finally {
                  setBusy('');
                }
              }}
              className="flex items-center gap-2 rounded-xl bg-[#C62026] px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:bg-[#9f1b20]"
            >
              <Unplug size={15} />
              Disconnect
            </button>
          ) : (
            <button
              onClick={() => connectQuickbooks(location.pathname)}
              className="flex items-center gap-2 rounded-xl bg-[#8BC53D] px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:bg-[#476E2C]"
            >
              <Link2 size={15} />
              Connect QuickBooks
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {summaryCards.map((card) => (
          <div key={card.label} className="rounded-2xl bg-white p-5 shadow-card">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">{card.label}</p>
            <p className="mt-3 text-lg font-bold text-[#050505]">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_0.9fr]">
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="mb-4 flex items-center gap-2">
            {status.isConnected ? <CheckCircle2 size={18} className="text-[#476E2C]" /> : <ShieldAlert size={18} className="text-[#b45e08]" />}
            <h2 className="font-semibold text-[#050505]">Integration Status</h2>
          </div>
          {loading ? (
            <p className="text-sm text-[#6D6E71]">Loading connection details...</p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-gray-100 p-4">
                <p className="text-sm font-semibold text-[#050505]">{status.isConnected ? 'QuickBooks is connected' : 'QuickBooks is not connected'}</p>
                <p className="mt-2 text-sm leading-6 text-[#6D6E71]">
                  {status.isConnected
                    ? `Connected company: ${status.companyName || 'Unknown company'}. Use this connection for invoices, reports, and reconciliation in the workspace.`
                    : 'Connect QuickBooks to unlock invoice syncing, financial reporting, and reconciliation tools inside this company workspace.'}
                </p>
              </div>
              {!!status.tokenExpiresAt && (
                <div className="rounded-xl border border-gray-100 p-4">
                  <p className="text-sm font-semibold text-[#050505]">Token Expiry</p>
                  <p className="mt-2 text-sm text-[#6D6E71]">{new Date(status.tokenExpiresAt).toLocaleString()}</p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="mb-4 flex items-center gap-2">
            <AlertCircle size={18} className="text-[#00648F]" />
            <h2 className="font-semibold text-[#050505]">Synced Modules</h2>
          </div>
          <div className="space-y-3">
            {(status.syncedEntities || []).length > 0 ? (
              status.syncedEntities.map((entity) => (
                <div key={entity.name || entity} className="rounded-xl border border-gray-100 px-4 py-3">
                  <p className="text-sm font-semibold text-[#050505]">{entity.name || entity}</p>
                  {entity.lastSync && <p className="mt-1 text-xs text-[#6D6E71]">Last sync: {entity.lastSync}</p>}
                </div>
              ))
            ) : (
              <p className="text-sm text-[#6D6E71]">No QuickBooks modules are synced yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
