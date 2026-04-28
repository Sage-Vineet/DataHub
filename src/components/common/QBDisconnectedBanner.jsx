import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, X, Zap } from 'lucide-react';
import { getConnectionStatus } from '../../lib/quickbooks';
import { getCompanyRequest } from '../../lib/api';
import { cn } from '../../lib/utils';

/**
 * QBDisconnectedBanner
 *
 * Checks the QuickBooks connection status on mount and displays a dismissible
 * amber notification banner when QuickBooks is not connected.
 *
 * Props:
 *   pageName  (string) – friendly name of the current page shown in the message.
 */
export default function QBDisconnectedBanner({ pageName = 'this page' }) {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const [show, setShow] = useState(false);
  const [isMismatch, setIsMismatch] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [qbCompanyName, setQbCompanyName] = useState('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Only fetch company data if we have a real clientId (broker workspace)
    const companyPromise = clientId
      ? getCompanyRequest(clientId).catch(() => null)
      : Promise.resolve(null);

    // Check both status and current company info to verify isolation
    Promise.all([
      getConnectionStatus().catch(() => ({ isConnected: false })),
      companyPromise
    ])
      .then(([qbData, wpData]) => {
        if (cancelled) return;

        const wpName = wpData?.name?.trim().toLowerCase();
        const qbName = qbData?.companyName?.trim().toLowerCase();
        const mismatch = qbData?.isConnected && wpName && qbName && wpName !== qbName;

        setCompanyName(wpData?.name || '');
        setQbCompanyName(qbData?.companyName || '');

        if (mismatch) {
          // Hide mismatch banners as per user request
          setIsMismatch(false);
          setShow(false);
        } else if (!qbData?.isConnected) {
          setIsMismatch(false);
          setShow(true);
        }
      })
      .catch(() => {
        if (!cancelled) setShow(true);
      });

    return () => { cancelled = true; };
  }, [clientId]);

  if (!show || dismissed) return null;

  const connectionsPath = clientId
    ? `/broker/client/${clientId}/connections`
    : null;

  const handleGoToConnections = () => {
    setDismissed(true);
    if (connectionsPath) navigate(connectionsPath);
  };

  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-4 px-5 py-4 rounded-xl border shadow-sm animate-in fade-in slide-in-from-top-2 duration-300",
        isMismatch
          ? "border-red-300/60 bg-red-50 text-red-800"
          : "border-amber-300/70 bg-amber-50 text-amber-800"
      )}
    >
      {/* Icon */}
      <span className={cn("mt-0.5 shrink-0", isMismatch ? "text-red-500" : "text-amber-500")}>
        <AlertTriangle size={18} />
      </span>

      {/* Message */}
      <div className="flex-1 min-w-0">
        <p className={cn("font-bold text-[14px] leading-snug", isMismatch ? "text-red-900" : "text-amber-900")}>
          {isMismatch ? 'QuickBooks Company Mismatch' : 'QuickBooks Disconnected — Showing Cached Data'}
        </p>
        <p className={cn("mt-1 text-[13px] leading-relaxed", isMismatch ? "text-red-700" : "text-amber-700")}>
          {isMismatch ? (
            <>
              The connected QuickBooks account (<span className="font-bold underline">{qbCompanyName}</span>) does not match the current workspace (<span className="font-bold underline">{companyName}</span>).
              <span className="block mt-1">Please switch to the correct company or reconnect to ensure data integrity.</span>
            </>
          ) : (
            <>
              You are currently disconnected. The data shown is from your last sync and may not reflect recent changes.
              <span className="block mt-1">To get live financial data, reconnect your QuickBooks account.</span>
            </>
          )}
        </p>
      </div>

      {/* CTA */}
      {connectionsPath && (
        <button
          onClick={handleGoToConnections}
          className={cn(
            "shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-bold transition-all shadow-sm",
            isMismatch
              ? "bg-red-600 hover:bg-red-700 text-white"
              : "bg-amber-500 hover:bg-amber-600 text-white"
          )}
        >
          <Zap size={14} />
          {isMismatch ? 'Fix Connection' : 'Connect Now'}
          <ArrowRight size={13} />
        </button>
      )}

      {/* Dismiss */}
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss notification"
        className={cn(
          "shrink-0 mt-0.5 transition-colors",
          isMismatch ? "text-red-400 hover:text-red-700" : "text-amber-400 hover:text-amber-700"
        )}
      >
        <X size={16} />
      </button>
    </div>
  );
}
