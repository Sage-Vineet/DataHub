import { useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import FileExplorer from '../../components/fileExplorer/FileExplorer';

function resolveAssignedCompanies(user) {
  // AuthContext normalizes both assigned_companies and assignedCompanies — check both
  const list = user?.assigned_companies?.length
    ? user.assigned_companies
    : user?.assignedCompanies?.length
    ? user.assignedCompanies
    : [];

  if (list.length > 0) return list;

  // Fallback: build single-company list from company_id
  const fallbackId = user?.company_id || user?.companyId || user?.company_ids?.[0] || user?.companyIds?.[0];
  if (fallbackId) {
    return [{ id: fallbackId, name: user?.company || user?.company_name || 'My Company' }];
  }

  return [];
}

export default function ClientUpload() {
  const { user } = useAuth();

  const assignedCompanies = useMemo(
    () => resolveAssignedCompanies(user),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.assigned_companies, user?.assignedCompanies, user?.company_id, user?.companyId, user?.company, user?.company_name],
  );

  const [selectedCompanyId, setSelectedCompanyId] = useState(assignedCompanies[0]?.id || null);
  const companyId = selectedCompanyId || assignedCompanies[0]?.id || null;
  const fileExplorerRole = user?.role === 'user' ? 'user' : 'client';

  return (
    <div className="-m-4 lg:-m-6 h-[calc(100vh-4rem)]">
      {assignedCompanies.length > 1 && (
        <div className="absolute right-4 top-4 z-20 rounded-2xl border border-gray-200 bg-white/95 p-2 shadow-card">
          <select
            value={companyId || ''}
            onChange={(e) => setSelectedCompanyId(e.target.value)}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-[#8BC53D] hover:border-[#8BC53D]/30"
          >
            {assignedCompanies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.project_name || company.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <FileExplorer role={fileExplorerRole} companyId={companyId} currentUserId={user?.id} />
    </div>
  );
}
