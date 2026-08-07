import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
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

export default function ClientDocuments() {
  const { user } = useAuth();

  const assignedCompanies = useMemo(
    () => resolveAssignedCompanies(user),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.assigned_companies, user?.assignedCompanies, user?.company_id, user?.companyId, user?.company, user?.company_name],
  );

  const [selectedCompanyId, setSelectedCompanyId] = useState(assignedCompanies[0]?.id || null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  const companyId = selectedCompanyId || assignedCompanies[0]?.id || null;
  const fileExplorerRole = user?.role === 'user' ? 'user' : 'client';

  const filteredCompanies = assignedCompanies.filter((company) =>
    (company.project_name || company.name || '').toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const selectedCompany = assignedCompanies.find((c) => c.id === selectedCompanyId);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Documents</h1>
          <p className="text-sm text-[#6D6E71] mt-0.5">Access files and documents shared with you</p>
        </div>
      </div>

      {assignedCompanies.length > 0 && (
        <div className="bg-white rounded-2xl shadow-card p-5">
          <label className="block text-sm font-semibold text-[#050505] mb-3">Select Company</label>
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setIsOpen(!isOpen)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 border-gray-200 hover:border-[#8BC53D]/50 transition-colors text-left bg-white"
            >
              <span className="text-sm font-medium text-[#050505]">
                {selectedCompany?.name || 'Select a company'}
              </span>
              <ChevronDown
                size={18}
                className={`text-[#6D6E71] transition-transform ${isOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {isOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-200 rounded-xl shadow-lg z-10 max-h-60 overflow-y-auto">
                <div className="sticky top-0 bg-white border-b border-gray-100 p-3">
                  <div className="relative">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A5A5A5]" />
                    <input
                      type="text"
                      placeholder="Search companies..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-xs focus:outline-none focus:border-[#8BC53D]"
                      autoFocus
                    />
                  </div>
                </div>
                <div>
                  {filteredCompanies.length > 0 ? (
                    filteredCompanies.map((company) => (
                      <button
                        key={company.id}
                        onClick={() => { setSelectedCompanyId(company.id); setSearchQuery(''); setIsOpen(false); }}
                        className={`w-full text-left px-4 py-3 text-sm transition-colors hover:bg-[#E6F3D3] ${selectedCompanyId === company.id ? 'bg-[#E6F3D3] text-[#8BC53D] font-semibold' : 'text-[#050505] hover:text-[#8BC53D]'}`}
                      >
                        <div className="flex items-center gap-2">
                          {selectedCompanyId === company.id && (
                            <svg className="w-4 h-4 text-[#8BC53D]" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          )}
                          <span>{company.project_name || company.name}</span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="px-4 py-6 text-center text-xs text-[#A5A5A5]">No companies found</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {companyId ? (
        <div className="-m-4 lg:-m-6 h-[calc(100vh-18rem)]">
          <FileExplorer
            role={fileExplorerRole}
            companyId={companyId}
            currentUserId={user?.id}
            title={`Documents - ${selectedCompany?.name || 'Documents'}`}
          />
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-card p-8 text-center">
          <p className="text-sm text-[#A5A5A5]">
            No companies assigned. Please contact your administrator to get access.
          </p>
        </div>
      )}
    </div>
  );
}
