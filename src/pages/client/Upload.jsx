import { useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import FileExplorer from '../../components/fileExplorer/FileExplorer';

export default function ClientUpload() {
  const { user } = useAuth();
  const assignedCompanies = useMemo(() => (
    user?.assignedCompanies?.length
      ? user.assignedCompanies
      : [{ id: user?.company_id || user?.companyId, name: user?.company }].filter((company) => company.id)
  ), [user?.assignedCompanies, user?.company_id, user?.companyId, user?.company]);
  const [selectedCompanyId, setSelectedCompanyId] = useState(assignedCompanies[0]?.id || null);
  const companyId = selectedCompanyId || user?.company_id || user?.companyId || null;
  const fileExplorerRole = user?.role === 'user' ? 'user' : 'client';

  return (
    <div className="-m-4 lg:-m-6 h-[calc(100vh-4rem)]">
      {assignedCompanies.length > 1 && (
        <div className="absolute right-4 top-4 z-20 rounded-2xl border border-gray-200 bg-white/95 p-2 shadow-card">
          <select
            value={companyId || ''}
            onChange={(event) => setSelectedCompanyId(event.target.value)}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-[#05164D]"
          >
            {assignedCompanies.map((company) => (
              <option key={company.id} value={company.id}>{company.name}</option>
            ))}
          </select>
        </div>
      )}
      <FileExplorer role={fileExplorerRole} companyId={companyId} currentUserId={user?.id} />
    </div>
  );
}
