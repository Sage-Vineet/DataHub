import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, BadgeDollarSign, Building2, Download, Search, ShieldCheck, Users } from 'lucide-react';
import { companies as mockCompanies } from '../../data/mockData';
import { buildClientLedger, formatUsd } from '../../lib/dataHub';
import { listCompaniesRequest } from '../../lib/api';

function normalizeCompany(company) {
  return {
    id: company.id,
    name: company.name,
    contact: company.contact || company.contact_name || 'Account Lead',
    email: company.email || company.contact_email || 'Not available',
    phone: company.phone || company.contact_phone || 'Not available',
    industry: company.industry || 'General',
    status: company.status || 'active',
    requestCount: company.requestCount || company.request_count || 0,
    pendingCount: company.pendingCount || company.pending_request_count || 0,
    completedCount: company.completedCount || company.completed_request_count || 0,
  };
}

export default function BrokerClients() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [clients, setClients] = useState(buildClientLedger(mockCompanies.map(normalizeCompany)));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    listCompaniesRequest()
      .then((response) => {
        if (cancelled) return;
        setClients(buildClientLedger(response.map(normalizeCompany)));
      })
      .catch(() => {
        if (!cancelled) {
          setClients(buildClientLedger(mockCompanies.map(normalizeCompany)));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredClients = useMemo(() => {
    const term = search.trim().toLowerCase();

    return clients.filter((client) => {
      if (!term) return true;

      return [client.name, client.contact, client.industry, client.email]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(term));
    });
  }, [clients, search]);

  const summary = useMemo(() => {
    const totalBalance = filteredClients.reduce((sum, client) => sum + client.openBalance, 0);
    const avgHealth = filteredClients.length
      ? Math.round(filteredClients.reduce((sum, client) => sum + client.healthScore, 0) / filteredClients.length)
      : 0;

    return {
      totalClients: filteredClients.length,
      healthyClients: filteredClients.filter((client) => client.financeStatus === 'healthy').length,
      totalBalance,
      avgHealth,
    };
  }, [filteredClients]);

  const handleExport = () => {
    const headers = ['Client', 'Industry', 'Account Owner', 'Health Score', 'Open Balance', 'Relationship Tier', 'Last Finance Sync'];
    const rows = filteredClients.map((client) => [
      client.name,
      client.industry,
      client.accountOwner,
      client.healthScore,
      client.openBalance,
      client.relationshipTier,
      client.lastFinanceSync,
    ]);

    const csv = [headers, ...rows].map((row) => row.map((value) => `"${value}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'broker-clients.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Clients</h1>
          <p className="mt-0.5 text-sm text-[#6D6E71]">Data Hub client operations merged into the broker workspace.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/broker/companies')}
            className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-[#050505] shadow-sm transition-all hover:bg-gray-50"
          >
            <Building2 size={15} className="text-[#6D6E71]" />
            View Companies
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 rounded-xl bg-[#8BC53D] px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:bg-[#476E2C]"
          >
            <Download size={15} />
            Export
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: 'Tracked Clients', value: summary.totalClients, icon: Users, tone: '#8BC53D', bg: '#ECF8D8' },
          { label: 'Healthy Accounts', value: summary.healthyClients, icon: ShieldCheck, tone: '#476E2C', bg: '#E8F3D8' },
          { label: 'Open Balance', value: formatUsd(summary.totalBalance), icon: BadgeDollarSign, tone: '#00648F', bg: '#E5F4FB' },
          { label: 'Average Health', value: `${summary.avgHealth}%`, icon: Building2, tone: '#F68C1F', bg: '#FFF1E2' },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl bg-white p-5 shadow-card">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ backgroundColor: card.bg }}>
                <card.icon size={20} style={{ color: card.tone }} />
              </div>
            </div>
            <p className="text-2xl font-bold text-[#050505]">{card.value}</p>
            <p className="mt-1 text-sm text-[#6D6E71]">{card.label}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-card">
        <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 focus-within:ring-2 focus-within:ring-[#8BC53D]/30">
          <Search size={15} className="text-[#A5A5A5]" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search clients, owners, or industry..."
            className="w-full bg-transparent text-sm text-[#050505] outline-none placeholder:text-[#A5A5A5]"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-6 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Client</th>
                <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Account Owner</th>
                <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Tier</th>
                <th className="px-4 py-3 text-right text-[13px] font-semibold text-[#6D6E71]">Open Balance</th>
                <th className="px-4 py-3 text-right text-[13px] font-semibold text-[#6D6E71]">Health</th>
                <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#6D6E71]">Finance Sync</th>
                <th className="px-4 py-3 text-right text-[13px] font-semibold text-[#6D6E71]">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredClients.map((client) => (
                <tr key={client.id} className="hover:bg-[#FAFBF7]">
                  <td className="px-6 py-4">
                    <div>
                      <p className="text-sm font-semibold text-[#050505]">{client.name}</p>
                      <p className="mt-1 text-xs text-[#6D6E71]">{client.contact} • {client.industry}</p>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-sm text-[#050505]">{client.accountOwner}</td>
                  <td className="px-4 py-4">
                    <span className="rounded-full bg-[#EEF6E0] px-3 py-1 text-xs font-semibold text-[#476E2C]">
                      {client.relationshipTier}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right text-sm font-semibold text-[#050505]">{formatUsd(client.openBalance)}</td>
                  <td className="px-4 py-4 text-right">
                    <span className={`text-sm font-bold ${client.healthScore >= 90 ? 'text-[#476E2C]' : client.healthScore >= 80 ? 'text-[#00648F]' : 'text-[#C62026]'}`}>
                      {client.healthScore}%
                    </span>
                  </td>
                  <td className="px-4 py-4 text-sm text-[#6D6E71]">{client.lastFinanceSync}</td>
                  <td className="px-4 py-4 text-right">
                    <button
                      onClick={() => navigate(`/broker/client/${client.id}/datahub-dashboard`, { state: { company: client } })}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-[#050505] transition-all hover:border-[#8BC53D]/50 hover:bg-[#F8FBF1]"
                    >
                      Open Workspace
                      <ArrowRight size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && filteredClients.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-16 text-center text-sm text-[#6D6E71]">
                    No clients match the current search.
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
