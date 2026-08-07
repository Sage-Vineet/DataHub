import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowRight, X, Zap } from 'lucide-react';
import { getConnectionStatus } from '../../lib/quickbooks';
import { useDataSource } from '../../context/DataSourceContext';

export default function QBDisconnectedBanner() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const { activeSourceMode } = useDataSource();
  const [show, setShow] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (activeSourceMode !== 'quickbooks') return;

    let cancelled = false;

    getConnectionStatus()
      .catch(() => ({ isConnected: false }))
      .then((qbData) => {
        if (cancelled) return;
        if (!qbData?.isConnected) {
          setShow(true);
          setLastSyncAt(
            qbData?.lastSyncAt ||
            qbData?.lastSyncedAt ||
            qbData?.lastCacheSyncedAt ||
            null,
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSourceMode]);

  if (!show || dismissed || activeSourceMode !== 'quickbooks') return null;

  const connectionsPath = clientId ? `/broker/client/${clientId}/dataroom/connections` : null;

  const handleGoToConnections = () => {
    setDismissed(true);
    if (connectionsPath) navigate(connectionsPath);
  };

  return (
    <div
      role="alert"
      className="flex items-start gap-4 px-5 py-4 rounded-xl border border-amber-300/70 bg-amber-50 text-amber-800 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300"
    >
      <span className="mt-0.5 shrink-0 text-amber-500">
        <AlertTriangle size={18} />
      </span>

      <div className="flex-1 min-w-0">
        <p className="font-bold text-[14px] leading-snug text-amber-900">
          QuickBooks disconnected. Showing last synced data.
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-amber-700">
          You are currently disconnected. The data shown is from your last successful sync and may not reflect recent changes.
          {lastSyncAt ? (
            <span className="block mt-1">
              Last synced: {new Date(lastSyncAt).toLocaleString()}
            </span>
          ) : null}
          <span className="block mt-1">To get live financial data, reconnect your QuickBooks account.</span>
        </p>
      </div>

      {connectionsPath && (
        <button
          onClick={handleGoToConnections}
          className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-bold bg-amber-500 hover:bg-amber-600 text-white transition-all shadow-sm"
        >
          <Zap size={14} />
          Connect Now
          <ArrowRight size={13} />
        </button>
      )}

      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss notification"
        className="shrink-0 mt-0.5 text-amber-400 hover:text-amber-700 transition-colors"
      >
        <X size={16} />
      </button>
    </div>
  );
}
