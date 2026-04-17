import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Briefcase, Building2, CheckCircle2, Mail, Phone, ShieldCheck, FileText, BarChart3, Folder, TrendingUp, DollarSign, Calendar } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { getCompanyRequest, listCompaniesRequest, listCompanyRequests, listCompanyFolders, listRequestDocuments } from '../../lib/api';
import { getAssignedCompanies, normalizeAssignedCompany } from './portalUtils';

export default function UserCompanyDetails() {
  const { user } = useAuth();
  const { clientId } = useParams();
  const navigate = useNavigate();
  const assignedCompanies = useMemo(() => getAssignedCompanies(user), [user]);
  const assignedCompany = useMemo(
    () => assignedCompanies.find((company) => String(company.id) === String(clientId)) || null,
    [assignedCompanies, clientId]
  );
  const [company, setCompany] = useState(assignedCompany);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [companyData, setCompanyData] = useState({
    requests: [],
    folders: [],
    documents: [],
    docsByCategory: {},
  });

  useEffect(() => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    if (!assignedCompany) {
      setError("You don't have access to this company.");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError('');

    const fetchCompanyData = async () => {
      try {
        const [details, companies, requests, folders] = await Promise.all([
          getCompanyRequest(clientId).catch(() => null),
          listCompaniesRequest().catch(() => []),
          listCompanyRequests(clientId).catch(() => []),
          listCompanyFolders(clientId).catch(() => []),
        ]);

        if (cancelled) return;

        const companyFromList = companies.find((entry) => String(entry.id) === String(clientId)) || null;
        setCompany(normalizeAssignedCompany(details || companyFromList || assignedCompany));

        // Build document categories (exclude invoices)
        const allDocs = [];
        const docsByCategory = {};

        for (const req of requests) {
          try {
            const docs = await listRequestDocuments(req.id);
            for (const doc of docs) {
              // Skip invoices
              if (doc.type && doc.type.toLowerCase().includes('invoice')) continue;
              allDocs.push(doc);
              const category = req.category || 'Other';
              if (!docsByCategory[category]) {
                docsByCategory[category] = [];
              }
              docsByCategory[category].push(doc);
            }
          } catch {
            // Handle error silently
          }
        }

        if (!cancelled) {
          setCompanyData({
            requests,
            folders,
            documents: allDocs,
            docsByCategory,
          });
        }
      } catch (err) {
        if (cancelled) return;
        setCompanyData({ requests: [], folders: [], documents: [], docsByCategory: {} });
        setError(err.message || 'Unable to load company details.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchCompanyData();

    return () => {
      cancelled = true;
    };
  }, [clientId, assignedCompany]);

  if (!loading && !assignedCompany) {
    return (
      <div className="rounded-3xl border border-[#E5E7EF] bg-white p-10 text-center shadow-sm">
        <Building2 size={34} className="mx-auto mb-4 text-[#A5A5A5]" />
        <h1 className="text-2xl font-bold text-[#05164D]">Company not available</h1>
        <p className="mt-2 text-sm text-[#6D6E71]">This company is not part of your assigned access.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate('/user/portal-dashboard')}
        className="inline-flex items-center gap-2 rounded-xl border border-[#E5E7EF] bg-white px-4 py-2 text-sm font-semibold text-[#6D6E71] transition-colors hover:bg-[#F8F9FC] hover:text-[#05164D]"
      >
        <ArrowLeft size={16} />
        Back to company list
      </button>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">{company?.name || 'Company Details'}</h1>
        <p className="text-sm text-[#6D6E71] mt-0.5">Company profile and available documents</p>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-[#05164D]">Profile</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl bg-[#F8F9FC] p-4">
              <p className="text-xs text-[#A5A5A5]">Industry</p>
              <p className="mt-1 text-sm font-semibold text-[#05164D]">{company?.industry || 'Not available'}</p>
            </div>
            <div className="rounded-2xl bg-[#F8F9FC] p-4">
              <p className="text-xs text-[#A5A5A5]">Status</p>
              <p className="mt-1 text-sm font-semibold capitalize text-[#05164D]">{company?.status || 'active'}</p>
            </div>
            <div className="rounded-2xl bg-[#F8F9FC] p-4">
              <p className="text-xs text-[#A5A5A5]">Contact Person</p>
              <p className="mt-1 text-sm font-semibold text-[#05164D]">{company?.contact_name || 'Primary Contact'}</p>
            </div>
            <div className="rounded-2xl bg-[#F8F9FC] p-4">
              <p className="text-xs text-[#A5A5A5]">Email</p>
              <p className="mt-1 text-sm font-semibold text-[#05164D]">{company?.contact_email || 'Not available'}</p>
            </div>
            <div className="rounded-2xl bg-[#F8F9FC] p-4 sm:col-span-2">
              <p className="text-xs text-[#A5A5A5]">Phone</p>
              <p className="mt-1 text-sm font-semibold text-[#05164D]">{company?.contact_phone || 'Not available'}</p>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-3xl bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold text-[#05164D]">Access Summary</h2>
            <div className="mt-4 space-y-3">
              {[
                { icon: ShieldCheck, title: 'Assigned by broker', value: 'You can review this company profile' },
                { icon: Building2, title: 'Company visibility', value: `${assignedCompanies.length} assigned compan${assignedCompanies.length === 1 ? 'y' : 'ies'}` },
                { icon: Briefcase, title: 'Portal type', value: 'User portal access' },
                { icon: Mail, title: 'Primary contact', value: company?.contact_email || 'Not available' },
                { icon: Phone, title: 'Reachability', value: company?.contact_phone || 'Not available' },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="flex items-start gap-3 rounded-2xl bg-[#F8F9FC] p-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-[#8BC53D] shadow-sm">
                      <Icon size={18} />
                    </div>
                    <div>
                      <p className="text-xs text-[#A5A5A5]">{item.title}</p>
                      <p className="mt-1 text-sm font-semibold text-[#05164D]">{item.value}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-3xl border border-[#E5E7EF] bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <CheckCircle2 size={20} className="text-[#476E2C]" />
              <div>
                <h3 className="text-base font-bold text-[#05164D]">User scope</h3>
                <p className="text-sm text-[#6D6E71]">This portal is intentionally limited to company list and company details.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Data Availability Overview */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">Total Documents</p>
              <p className="mt-2 text-2xl font-bold text-[#05164D]">{companyData.documents.length}</p>
            </div>
            <FileText size={24} className="text-[#8BC53D]" />
          </div>
        </div>

        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">Data Rooms</p>
              <p className="mt-2 text-2xl font-bold text-[#05164D]">{companyData.folders.length}</p>
            </div>
            <Folder size={24} className="text-[#476E2C]" />
          </div>
        </div>

        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">Categories</p>
              <p className="mt-2 text-2xl font-bold text-[#05164D]">{Object.keys(companyData.docsByCategory).length}</p>
            </div>
            <BarChart3 size={24} className="text-[#8BC53D]" />
          </div>
        </div>

        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">Info Requests</p>
              <p className="mt-2 text-2xl font-bold text-[#05164D]">{companyData.requests.length}</p>
            </div>
            <TrendingUp size={24} className="text-[#476E2C]" />
          </div>
        </div>
      </div>

      {/* Document Categories Section */}
      {Object.keys(companyData.docsByCategory).length > 0 && (
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-[#05164D]">Documents by Category</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(companyData.docsByCategory).map(([category, docs]) => (
              <div key={category} className="rounded-2xl border border-[#E5E7EF] p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[#05164D]">{category}</h3>
                  <span className="rounded-full bg-[#E6F3D3] px-2.5 py-1 text-xs font-bold text-[#8BC53D]">
                    {docs.length}
                  </span>
                </div>
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {docs.slice(0, 5).map((doc, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-xs text-[#6D6E71]">
                      <FileText size={12} className="mt-1 flex-shrink-0 text-[#A5A5A5]" />
                      <span className="truncate">{doc.name || doc.title || 'Document'}</span>
                    </div>
                  ))}
                  {docs.length > 5 && (
                    <p className="text-xs text-[#A5A5A5] italic">
                      +{docs.length - 5} more document{docs.length - 5 > 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Data Rooms / Folders Section */}
      {companyData.folders.length > 0 && (
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-[#05164D]">Data Rooms Available</h2>
          <div className="mt-5 space-y-3">
            {companyData.folders.slice(0, 10).map((folder) => (
              <div key={folder.id} className="flex items-center justify-between rounded-2xl border border-[#E5E7EF] p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#E6F3D3]">
                    <Folder size={18} className="text-[#8BC53D]" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[#05164D]">{folder.name}</p>
                    <p className="text-xs text-[#A5A5A5]">{folder.description || 'Data room'}</p>
                  </div>
                </div>
                <span className="text-xs font-semibold text-[#6D6E71]">
                  {folder.children?.length || 0} files
                </span>
              </div>
            ))}
            {companyData.folders.length > 10 && (
              <p className="text-center text-xs text-[#A5A5A5]">
                +{companyData.folders.length - 10} more data room{companyData.folders.length - 10 > 1 ? 's' : ''}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Empty State */}
      {companyData.documents.length === 0 && companyData.folders.length === 0 && !loading && (
        <div className="rounded-3xl border border-[#E5E7EF] bg-white p-8 text-center">
          <FileText size={32} className="mx-auto mb-3 text-[#A5A5A5]" />
          <h3 className="text-base font-bold text-[#05164D]">No data available yet</h3>
          <p className="mt-1 text-sm text-[#6D6E71]">
            Your broker will share company documents and data rooms as they become available.
          </p>
        </div>
      )}
    </div>
  );
}
