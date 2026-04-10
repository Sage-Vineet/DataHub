import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Download, FileText, Search, Wallet } from 'lucide-react';
import { companies as mockCompanies } from '../../data/mockData';
import { buildClientLedger, buildInvoiceLedger, formatUsd, summarizeInvoices } from '../../lib/dataHub';
import { listCompaniesRequest } from '../../lib/api';

function normalizeCompany(company) {
  return {
    id: company.id,
    name: company.name,
    contact: company.contact || company.contact_name || 'Account Lead',
    industry: company.industry || 'General',
    status: company.status || 'active',
    requestCount: company.requestCount || company.request_count || 0,
    pendingCount: company.pendingCount || company.pending_request_count || 0,
    completedCount: company.completedCount || company.completed_request_count || 0,
  };
}

export default function BrokerInvoices() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [invoices, setInvoices] = useState(buildInvoiceLedger(buildClientLedger(mockCompanies.map(normalizeCompany))));

  useEffect(() => {
    let cancelled = false;

    listCompaniesRequest()
      .then((response) => {
        if (cancelled) return;
        const nextClients = buildClientLedger(response.map(normalizeCompany));
        setInvoices(buildInvoiceLedger(nextClients));
      })
      .catch(() => {
        if (!cancelled) {
          setInvoices(buildInvoiceLedger(buildClientLedger(mockCompanies.map(normalizeCompany))));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredInvoices = useMemo(() => {
    const term = search.trim().toLowerCase();
    return invoices.filter((invoice) => {
      const matchesSearch = !term || [invoice.id, invoice.clientName, invoice.category]
        .some((value) => value.toLowerCase().includes(term));
      const matchesStatus = statusFilter === 'All' || invoice.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [invoices, search, statusFilter]);

  const summary = useMemo(() => summarizeInvoices(filteredInvoices), [filteredInvoices]);

  const handleExport = () => {
    const headers = ['Invoice', 'Client', 'Category', 'Status', 'Date', 'Due Date', 'Amount', 'Balance'];
    const rows = filteredInvoices.map((invoice) => [
      invoice.id,
      invoice.clientName,
      invoice.category,
      invoice.status,
      invoice.date,
      invoice.dueDate,
      invoice.amount,
      invoice.balance,
    ]);

    const csv = [headers, ...rows].map((row) => row.map((value) => `"${value}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'broker-invoices.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Invoices</h1>
          <p className="mt-0.5 text-sm text-[#6D6E71]">Data Hub invoice tracking is now available alongside the broker workspace.</p>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-2 rounded-xl bg-[#8BC53D] px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:bg-[#476E2C]"
        >
          <Download size={15} />
          Export Ledger
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: 'Invoice Volume', value: formatUsd(summary.totalVolume), icon: FileText, tone: '#00648F', bg: '#E5F4FB' },
          { label: 'Outstanding', value: formatUsd(summary.outstanding), icon: Wallet, tone: '#F68C1F', bg: '#FFF1E2' },
          { label: 'Open', value: summary.openCount, icon: AlertCircle, tone: '#05164D', bg: '#E8ECF5' },
          { label: 'Paid', value: summary.paidCount, icon: Wallet, tone: '#476E2C', bg: '#E8F3D8' },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl bg-white p-5 shadow-card">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl" style={{ backgroundColor: card.bg }}>
              <card.icon size={20} style={{ color: card.tone }} />
            </div>
            <p className="text-2xl font-bold text-[#050505]">{card.value}</p>
            <p className="mt-1 text-sm text-[#6D6E71]">{card.label}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-card md:flex-row md:items-center">
        <div className="flex flex-1 items-center gap-2 rounded-xl border border-gray-200 px-3 py-2">
          <Search size={15} className="text-[#A5A5A5]" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search invoice, client, or category..."
            className="w-full bg-transparent text-sm text-[#050505] outline-none placeholder:text-[#A5A5A5]"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-[#050505] outline-none"
        >
          {['All', 'Paid', 'Open', 'Draft', 'Overdue'].map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-6 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Invoice</th>
                <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Client</th>
                <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Category</th>
                <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Status</th>
                <th className="px-4 py-3 text-right text-[13px] font-semibold text-[#6D6E71]">Amount</th>
                <th className="px-4 py-3 text-right text-[13px] font-semibold text-[#6D6E71]">Balance</th>
                <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Due Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredInvoices.map((invoice) => (
                <tr key={invoice.id} className="hover:bg-[#FAFBF7]">
                  <td className="px-6 py-4">
                    <p className="text-sm font-semibold text-[#050505]">{invoice.id}</p>
                    <p className="mt-1 text-xs text-[#6D6E71]">Issued {invoice.date}</p>
                  </td>
                  <td className="px-4 py-4 text-sm text-[#050505]">{invoice.clientName}</td>
                  <td className="px-4 py-4 text-sm text-[#6D6E71]">{invoice.category}</td>
                  <td className="px-4 py-4">
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      invoice.status === 'Paid'
                        ? 'bg-[#E8F3D8] text-[#476E2C]'
                        : invoice.status === 'Open'
                          ? 'bg-[#E5F4FB] text-[#00648F]'
                          : invoice.status === 'Overdue'
                            ? 'bg-[#FDECEC] text-[#C62026]'
                            : 'bg-[#F2F3F5] text-[#6D6E71]'
                    }`}>
                      {invoice.status}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right text-sm font-semibold text-[#050505]">{invoice.formattedAmount}</td>
                  <td className="px-4 py-4 text-right text-sm text-[#050505]">{invoice.formattedBalance}</td>
                  <td className="px-4 py-4 text-sm text-[#6D6E71]">{invoice.dueDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
