import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { AlertCircle, Download, Link2, RefreshCw, Search } from 'lucide-react';
import { fetchQuickbooksInvoices, formatCurrency, getConnectionStatus, connectQuickbooks } from '../../../lib/quickbooks';
import { getCompanyRequest } from '../../../lib/api';
import { useToast } from '../../../context/ToastContext';

function matchesCompany(invoice, companyName) {
  const customerName = `${invoice?.CustomerRef?.name || invoice?.customer || ''}`.toLowerCase();
  const target = `${companyName || ''}`.toLowerCase();
  return customerName && target && (customerName.includes(target) || target.includes(customerName));
}

export default function WorkspaceInvoices() {
  const { clientId } = useParams();
  const location = useLocation();
  const { showToast } = useToast();
  const [company, setCompany] = useState(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [invoices, setInvoices] = useState([]);

  useEffect(() => {
    let active = true;

    const loadInvoices = async () => {
      setLoading(true);
      setError('');
      try {
        const [companyPayload, connection] = await Promise.all([
          getCompanyRequest(clientId),
          getConnectionStatus(),
        ]);
        if (!active) return;
        setCompany(companyPayload);
        setConnected(connection.isConnected);
        if (!connection.isConnected) {
          setInvoices([]);
          return;
        }
        const invoicePayload = await fetchQuickbooksInvoices();
        if (!active) return;
        setInvoices(invoicePayload?.QueryResponse?.Invoice || []);
      } catch (nextError) {
        if (!active) return;
        setError(nextError.message || 'Unable to load QuickBooks invoices.');
        try {
          const connection = await getConnectionStatus();
          if (!active) return;
          setConnected(connection.isConnected);
        } catch {
          setConnected(false);
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    loadInvoices();

    return () => {
      active = false;
    };
  }, [clientId]);

  useEffect(() => {
    if (!error) return;
    showToast({
      type: 'error',
      title: 'Invoice Notice',
      message: error,
    });
  }, [error, showToast]);

  const loadInvoices = async () => {
    setLoading(true);
    setError('');
    try {
      const [companyPayload, connection] = await Promise.all([
        getCompanyRequest(clientId),
        getConnectionStatus(),
      ]);
      setCompany(companyPayload);
      setConnected(connection.isConnected);
      if (!connection.isConnected) {
        setInvoices([]);
        return;
      }
      const invoicePayload = await fetchQuickbooksInvoices();
      setInvoices(invoicePayload?.QueryResponse?.Invoice || []);
      } catch (nextError) {
      setError(nextError.message || 'Unable to load QuickBooks invoices.');
      try {
        const connection = await getConnectionStatus();
        setConnected(connection.isConnected);
      } catch {
        setConnected(false);
      }
    } finally {
      setLoading(false);
    }
  };

  const scopedInvoices = useMemo(() => {
    const companyName = company?.name || '';
    const byCompany = invoices.filter((invoice) => matchesCompany(invoice, companyName));
    const source = byCompany.length > 0 ? byCompany : invoices;
    const term = search.trim().toLowerCase();

    return source.filter((invoice) => {
      if (!term) return true;
      return `${invoice.DocNumber || ''} ${invoice.CustomerRef?.name || ''} ${invoice.PrivateNote || ''}`
        .toLowerCase()
        .includes(term);
    });
  }, [company?.name, invoices, search]);

  const summary = useMemo(() => scopedInvoices.reduce((acc, invoice) => {
    const amount = Number(invoice.TotalAmt || 0);
    const balance = Number(invoice.Balance || 0);
    acc.total += amount;
    acc.outstanding += balance;
    if (balance === 0) acc.paid += 1;
    else if (new Date(invoice.DueDate || Date.now()) < new Date()) acc.overdue += 1;
    else acc.open += 1;
    return acc;
  }, { total: 0, outstanding: 0, paid: 0, overdue: 0, open: 0 }), [scopedInvoices]);

  const exportCsv = () => {
    const headers = ['Invoice', 'Client', 'Date', 'Due Date', 'Amount', 'Balance'];
    const rows = scopedInvoices.map((invoice) => [
      invoice.DocNumber,
      invoice.CustomerRef?.name || '',
      invoice.TxnDate,
      invoice.DueDate,
      invoice.TotalAmt,
      invoice.Balance,
    ]);
    const csv = [headers, ...rows].map((row) => row.map((value) => `"${value ?? ''}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${company?.name || 'workspace'}-invoices.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!connected && !loading) {
    return (
      <div className="rounded-2xl bg-white p-8 shadow-card">
        <h1 className="text-2xl font-bold text-[#050505]">Client Invoices</h1>
        <p className="mt-3 text-sm leading-6 text-[#6D6E71]">Connect QuickBooks for this workspace to view synced invoices.</p>
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
          <h1 className="text-2xl font-bold text-[#050505]">Client Invoices</h1>
          <p className="mt-0.5 text-sm text-[#6D6E71]">Invoice tracking for {company?.name || 'this company workspace'}.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadInvoices} className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-[#050505]">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button onClick={exportCsv} className="flex items-center gap-2 rounded-xl bg-[#8BC53D] px-4 py-2.5 text-sm font-semibold text-white">
            <Download size={15} />
            Export
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {[
          ['Invoice Value', formatCurrency(summary.total)],
          ['Outstanding', formatCurrency(summary.outstanding)],
          ['Open', summary.open],
          ['Overdue', summary.overdue],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-white p-5 shadow-card">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">{label}</p>
            <p className="mt-3 text-2xl font-bold text-[#050505]">{value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-card">
        <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2">
          <Search size={15} className="text-[#A5A5A5]" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search invoice number or customer..."
            className="w-full bg-transparent text-sm text-[#050505] outline-none"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-6 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Invoice</th>
                <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Customer</th>
                <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Date</th>
                <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Due Date</th>
                <th className="px-4 py-3 text-right text-[13px] font-semibold text-[#6D6E71]">Amount</th>
                <th className="px-4 py-3 text-right text-[13px] font-semibold text-[#6D6E71]">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {scopedInvoices.map((invoice) => (
                <tr key={`${invoice.Id || invoice.DocNumber}`} className="hover:bg-[#FAFBF7]">
                  <td className="px-6 py-4 text-sm font-semibold text-[#050505]">{invoice.DocNumber || invoice.Id}</td>
                  <td className="px-4 py-4 text-sm text-[#050505]">{invoice.CustomerRef?.name || 'Unknown'}</td>
                  <td className="px-4 py-4 text-sm text-[#6D6E71]">{invoice.TxnDate || '-'}</td>
                  <td className="px-4 py-4 text-sm text-[#6D6E71]">{invoice.DueDate || '-'}</td>
                  <td className="px-4 py-4 text-right text-sm font-semibold text-[#050505]">{formatCurrency(invoice.TotalAmt)}</td>
                  <td className="px-4 py-4 text-right text-sm text-[#050505]">{formatCurrency(invoice.Balance)}</td>
                </tr>
              ))}
              {!loading && scopedInvoices.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-16 text-center text-sm text-[#6D6E71]">
                    <div className="flex items-center justify-center gap-2">
                      <AlertCircle size={16} />
                      No invoices matched this company yet.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
