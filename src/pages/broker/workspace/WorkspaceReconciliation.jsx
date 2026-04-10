import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertCircle, Link2, RefreshCw, Upload } from 'lucide-react';
import {
  connectQuickbooks,
  fetchBankVsBooks,
  fetchReconciliationVariance,
  getConnectionStatus,
  syncGeneralLedger,
  uploadBankStatement,
  formatCurrency,
} from '../../../lib/quickbooks';
import { useToast } from '../../../context/ToastContext';

function todayRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export default function WorkspaceReconciliation() {
  const location = useLocation();
  const { showToast } = useToast();
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [variance, setVariance] = useState(null);
  const [matches, setMatches] = useState([]);
  const [range, setRange] = useState(todayRange());

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const connection = await getConnectionStatus();
      setConnected(connection.isConnected);
      if (!connection.isConnected) {
        setMatches([]);
        setVariance(null);
        return;
      }

      const [matchPayload, variancePayload] = await Promise.all([
        fetchBankVsBooks().catch(() => ({ data: [] })),
        fetchReconciliationVariance().catch(() => null),
      ]);
      setMatches(matchPayload?.data || []);
      setVariance(variancePayload);
    } catch (nextError) {
      setError(nextError.message || 'Unable to load reconciliation data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!error) return;
    showToast({
      type: 'error',
      title: 'Reconciliation Notice',
      message: error,
    });
  }, [error, showToast]);

  if (!connected && !loading) {
    return (
      <div className="rounded-2xl bg-white p-8 shadow-card">
        <h1 className="text-2xl font-bold text-[#050505]">Reconciliation</h1>
        <p className="mt-3 text-sm leading-6 text-[#6D6E71]">Connect QuickBooks before syncing general ledger data and bank-vs-books comparisons.</p>
        <button
          onClick={() => connectQuickbooks(location.pathname)}
          className="mt-5 flex items-center gap-2 rounded-xl bg-[#8BC53D] px-4 py-2.5 text-sm font-semibold text-white"
        >
          <Link2 size={15} />
          Connect QuickBooks
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Reconciliation</h1>
          <p className="mt-0.5 text-sm text-[#6D6E71]">Sync general ledger data and compare it with uploaded bank statement records.</p>
        </div>
        <button onClick={loadData} className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-[#050505]">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <h2 className="font-semibold text-[#050505]">Sync General Ledger</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input type="date" value={range.start} onChange={(event) => setRange((current) => ({ ...current, start: event.target.value }))} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm" />
            <input type="date" value={range.end} onChange={(event) => setRange((current) => ({ ...current, end: event.target.value }))} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm" />
          </div>
          <button
            onClick={async () => {
              setSyncing(true);
              try {
                await syncGeneralLedger({ start_date: range.start, end_date: range.end, accounting_method: 'Accrual' });
                await loadData();
              } catch (nextError) {
                setError(nextError.message || 'General ledger sync failed.');
              } finally {
                setSyncing(false);
              }
            }}
            className="mt-4 flex items-center gap-2 rounded-xl bg-[#8BC53D] px-4 py-2.5 text-sm font-semibold text-white"
          >
            <RefreshCw size={15} className={syncing ? 'animate-spin' : ''} />
            Sync Books
          </button>

          <div className="mt-6 border-t border-gray-100 pt-6">
            <h3 className="font-semibold text-[#050505]">Upload Bank Statement</h3>
            <p className="mt-2 text-sm leading-6 text-[#6D6E71]">Upload an Excel bank statement to compare bank movements against QuickBooks books data.</p>
            <label className="mt-4 flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-gray-300 px-4 py-3 text-sm font-semibold text-[#050505] hover:bg-[#FAFBF7]">
              <Upload size={15} />
              {uploading ? 'Uploading...' : 'Choose statement file'}
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setUploading(true);
                  try {
                    await uploadBankStatement(file);
                    await loadData();
                  } catch (nextError) {
                    setError(nextError.message || 'Bank statement upload failed.');
                  } finally {
                    setUploading(false);
                    event.target.value = '';
                  }
                }}
              />
            </label>
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-2xl bg-white p-5 shadow-card">
            <h2 className="font-semibold text-[#050505]">Variance</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-gray-100 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Bank Total</p>
                <p className="mt-3 text-xl font-bold text-[#050505]">{formatCurrency(variance?.bank_total)}</p>
              </div>
              <div className="rounded-xl border border-gray-100 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Books Total</p>
                <p className="mt-3 text-xl font-bold text-[#050505]">{formatCurrency(variance?.books_total)}</p>
              </div>
              <div className="rounded-xl border border-gray-100 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Variance</p>
                <p className="mt-3 text-xl font-bold text-[#050505]">{formatCurrency(variance?.variance_amount)}</p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-card">
            <h2 className="font-semibold text-[#050505]">Bank vs Books</h2>
            <div className="mt-4 space-y-3">
              {matches.slice(0, 8).map((row, index) => (
                <div key={`${row.bank_date}-${index}`} className="rounded-xl border border-gray-100 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[#050505]">{row.bank_narration || row.book_name || 'Record'}</p>
                      <p className="mt-1 text-xs text-[#6D6E71]">{row.bank_date || row.book_date}</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      row.remark === 'Matched' ? 'bg-[#E8F3D8] text-[#476E2C]' : 'bg-[#FFF1E2] text-[#b45e08]'
                    }`}>
                      {row.remark}
                    </span>
                  </div>
                </div>
              ))}
              {!loading && matches.length === 0 && (
                <p className="text-sm text-[#6D6E71]">No reconciliation rows are available yet. Sync books and upload a bank statement to begin.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
