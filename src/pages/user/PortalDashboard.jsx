import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Building2, Briefcase, Mail, Phone, FolderKanban, BarChart3, FileText, Eye, TrendingUp } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { listCompanyRequests, listCompanyFolders, listRequestDocuments } from '../../lib/api';
import { getAssignedCompanies } from './portalUtils';

export default function UserPortalDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const assignedCompanies = useMemo(() => getAssignedCompanies(user), [user]);
  
  const [stats, setStats] = useState({ totalDocs: 0, totalRequests: 0, totalFolders: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!assignedCompanies.length) {
      setLoading(false);
      return;
    }

    const fetchStats = async () => {
      try {
        let totalDocs = 0;
        let totalRequests = 0;
        let totalFolders = 0;

        for (const company of assignedCompanies) {
          try {
            const requests = await listCompanyRequests(company.id);
            totalRequests += requests.length;

            const folders = await listCompanyFolders(company.id);
            totalFolders += folders.length;

            // Count documents across all requests
            for (const req of requests) {
              try {
                const docs = await listRequestDocuments(req.id);
                totalDocs += docs.length;
              } catch {
                // Handle error silently
              }
            }
          } catch {
            // Handle error silently
          }
        }

        setStats({ totalDocs, totalRequests, totalFolders });
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [assignedCompanies]);

  if (!assignedCompanies.length) {
    return (
      <div className="rounded-3xl border border-[#E5E7EF] bg-white p-10 text-center shadow-sm">
        <Building2 size={34} className="mx-auto mb-4 text-[#A5A5A5]" />
        <h1 className="text-2xl font-bold text-[#05164D]">No companies assigned</h1>
        <p className="mt-2 text-sm text-[#6D6E71]">Ask your broker to assign one or more companies to your user account.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Assigned Companies</h1>
        <p className="text-sm text-[#6D6E71] mt-0.5">Review companies your broker assigned and access their data</p>
      </div>

      {/* Analytics Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">Companies Assigned</p>
              <p className="mt-2 text-3xl font-bold text-[#05164D]">{assignedCompanies.length}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#E6F3D3]">
              <Building2 size={24} className="text-[#8BC53D]" />
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">Data Rooms</p>
              <p className="mt-2 text-3xl font-bold text-[#05164D]">{stats.totalFolders}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#C9E4A4]">
              <FolderKanban size={24} className="text-[#476E2C]" />
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">Documents</p>
              <p className="mt-2 text-3xl font-bold text-[#05164D]">{stats.totalDocs}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#E6F3D3]">
              <FileText size={24} className="text-[#8BC53D]" />
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">Due Diligence</p>
              <p className="mt-2 text-3xl font-bold text-[#05164D]">{stats.totalRequests}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#C9E4A4]">
              <TrendingUp size={24} className="text-[#476E2C]" />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {assignedCompanies.map((company) => (
          <button
            key={company.id}
            onClick={() => navigate(`/user/company/${company.id}`)}
            className="group rounded-3xl border border-[#E7EAF1] bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-card"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#EEF6E0] text-lg font-bold text-[#476E2C]">
                {company.logo}
              </div>
              <span className="rounded-full bg-[#F4F6FA] px-2.5 py-1 text-[11px] font-semibold capitalize text-[#6D6E71]">
                {company.status}
              </span>
            </div>

            <h2 className="mt-4 text-lg font-bold text-[#05164D]">{company.name}</h2>
            <p className="mt-1 text-sm text-[#6D6E71]">{company.industry}</p>

            <div className="mt-4 space-y-2 text-sm text-[#6D6E71]">
              <div className="flex items-center gap-2">
                <Briefcase size={14} className="text-[#A5A5A5]" />
                <span>{company.contact_name}</span>
              </div>
              <div className="flex items-center gap-2">
                <Mail size={14} className="text-[#A5A5A5]" />
                <span className="truncate">{company.contact_email}</span>
              </div>
              <div className="flex items-center gap-2">
                <Phone size={14} className="text-[#A5A5A5]" />
                <span>{company.contact_phone}</span>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between rounded-2xl bg-[#F8F9FC] px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#05164D]">
                <FolderKanban size={16} className="text-[#8BC53D]" />
                Company details
              </div>
              <ArrowRight size={16} className="text-[#8BC53D] transition-transform group-hover:translate-x-0.5" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
