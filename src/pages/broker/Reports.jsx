import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Download, FileSpreadsheet, FileText, Layers3 } from 'lucide-react';
import { companies as mockCompanies } from '../../data/mockData';
import { buildClientLedger, buildInvoiceLedger, buildReportLibrary, summarizeInvoices } from '../../lib/dataHub';
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

export default function BrokerReports() {
  const [clients, setClients] = useState(buildClientLedger(mockCompanies.map(normalizeCompany)));

  useEffect(() => {
    let cancelled = false;

    listCompaniesRequest()
      .then((response) => {
        if (!cancelled) {
          setClients(buildClientLedger(response.map(normalizeCompany)));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setClients(buildClientLedger(mockCompanies.map(normalizeCompany)));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const invoices = useMemo(() => buildInvoiceLedger(clients), [clients]);
  const summary = useMemo(() => summarizeInvoices(invoices), [invoices]);
  const reportLibrary = useMemo(() => buildReportLibrary(clients, invoices), [clients, invoices]);

  const handleExportWorkbook = () => {
    const workbook = XLSX.utils.book_new();

    const clientSheet = XLSX.utils.json_to_sheet(
      clients.map((client) => ({
        Client: client.name,
        Industry: client.industry,
        Owner: client.accountOwner,
        Tier: client.relationshipTier,
        Health: client.healthScore,
        OpenBalance: client.openBalance,
        LastSync: client.lastFinanceSync,
      }))
    );

    const invoiceSheet = XLSX.utils.json_to_sheet(
      invoices.map((invoice) => ({
        Invoice: invoice.id,
        Client: invoice.clientName,
        Status: invoice.status,
        Category: invoice.category,
        Amount: invoice.amount,
        Balance: invoice.balance,
        Date: invoice.date,
        DueDate: invoice.dueDate,
      }))
    );

    XLSX.utils.book_append_sheet(workbook, clientSheet, 'Clients');
    XLSX.utils.book_append_sheet(workbook, invoiceSheet, 'Invoices');
    XLSX.writeFile(workbook, 'datahub-merged-reports.xlsx');
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Reports</h1>
          <p className="mt-0.5 text-sm text-[#6D6E71]">A lightweight reporting workspace built from the merged Leo and Data Hub views.</p>
        </div>
        <button
          onClick={handleExportWorkbook}
          className="flex items-center gap-2 rounded-xl bg-[#8BC53D] px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:bg-[#476E2C]"
        >
          <Download size={15} />
          Export Workbook
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {reportLibrary.map((report) => (
          <div key={report.id} className="rounded-2xl bg-white p-5 shadow-card">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl" style={{ backgroundColor: `${report.accent}1A` }}>
              <FileText size={20} style={{ color: report.accent }} />
            </div>
            <h2 className="text-lg font-semibold text-[#050505]">{report.title}</h2>
            <p className="mt-2 text-sm leading-6 text-[#6D6E71]">{report.description}</p>
            <div className="mt-5 rounded-xl bg-[#F8FAF4] px-4 py-3">
              <p className="text-2xl font-bold text-[#050505]">{report.metric}</p>
              <p className="mt-1 text-xs font-medium uppercase tracking-[0.08em] text-[#6D6E71]">{report.metricLabel}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="mb-5 flex items-center gap-2">
            <Layers3 size={17} className="text-[#00648F]" />
            <h2 className="font-semibold text-[#050505]">Merged Reporting Snapshot</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-gray-100 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Tracked Clients</p>
              <p className="mt-2 text-3xl font-bold text-[#050505]">{clients.length}</p>
              <p className="mt-2 text-sm text-[#6D6E71]">Portfolio accounts brought into the merged finance workspace.</p>
            </div>
            <div className="rounded-xl border border-gray-100 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Outstanding Balance</p>
              <p className="mt-2 text-3xl font-bold text-[#050505]">${summary.outstanding.toLocaleString('en-US')}</p>
              <p className="mt-2 text-sm text-[#6D6E71]">Open invoice exposure now visible from the broker app.</p>
            </div>
            <div className="rounded-xl border border-gray-100 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Open Invoices</p>
              <p className="mt-2 text-3xl font-bold text-[#050505]">{summary.openCount}</p>
              <p className="mt-2 text-sm text-[#6D6E71]">Invoices still awaiting payment or internal follow-up.</p>
            </div>
            <div className="rounded-xl border border-gray-100 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Paid Invoices</p>
              <p className="mt-2 text-3xl font-bold text-[#050505]">{summary.paidCount}</p>
              <p className="mt-2 text-sm text-[#6D6E71]">Completed invoice cycles visible inside the same project.</p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="mb-5 flex items-center gap-2">
            <FileSpreadsheet size={17} className="text-[#F68C1F]" />
            <h2 className="font-semibold text-[#050505]">Included Exports</h2>
          </div>
          <div className="space-y-3">
            {[
              'Client portfolio workbook',
              'Invoice ledger export',
              'Finance health snapshot',
            ].map((item) => (
              <div key={item} className="rounded-xl border border-gray-100 px-4 py-3 text-sm text-[#050505]">
                {item}
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm leading-6 text-[#6D6E71]">
            This report surface is intentionally isolated from the existing client-facing workflows, so the original request and workspace logic stays untouched.
          </p>
        </div>
      </div>
    </div>
  );
}
