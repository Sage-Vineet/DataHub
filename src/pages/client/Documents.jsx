import { useMemo, useState, useRef, useEffect } from 'react';
import { Search, ChevronDown, Send } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import FileExplorer from '../../components/fileExplorer/FileExplorer';
import NewRequestModal from '../../components/NewRequestModal';
import { createCompanyRequestItem, listFolderTree } from '../../lib/api';
import { buildFolderOptionsFromTree } from '../../lib/folderOptions';

function mapToCategory(item) {
  const text = `${item.name} ${item.subLabel || ''} ${item.description || ''}`.toLowerCase();
  if (text.includes('revenue recognition') || text.includes('trial balance')) return 'Finance';
  if (text.includes('litigation') || text.includes('arbitration')) return 'Legal';
  if (text.includes('tax')) return 'Tax';
  if (text.includes('hr') || text.includes('people') || text.includes('employment')) return 'HR';
  if (text.includes('m&a') || text.includes('merger') || text.includes('acquisition')) return 'M&A';
  if ((item.category || '').toLowerCase().includes('finance')) return 'Finance';
  if ((item.category || '').toLowerCase().includes('legal')) return 'Legal';
  if ((item.category || '').toLowerCase().includes('tax')) return 'Tax';
  if ((item.category || '').toLowerCase().includes('hr')) return 'HR';
  if ((item.category || '').toLowerCase().includes('m&a')) return 'M&A';
  if ((item.category || '').toLowerCase().includes('compliance') || text.includes('compliance') || text.includes('regulatory') || text.includes('gst')) return 'Compliance';
  return 'Other';
}

function normalizePriority(priority) {
  if (priority === 'critical' || priority === 'high' || priority === 'medium' || priority === 'low') return priority;
  return 'medium';
}

function buildCreateRequestPayload(form) {
  const folderLabel = form.requestType === 'Information' ? '' : (form.category || '').trim();
  const resolvedCategory = mapToCategory({
    name: form.name?.trim() || '',
    subLabel: folderLabel,
    description: form.description?.trim() || '',
    category: folderLabel,
  });
  const responseType = form.requestType === 'Information' ? 'Narrative' : 'Both';

  return {
    title: form.name.trim(),
    sub_label: folderLabel,
    description: form.description?.trim() || '',
    category: resolvedCategory,
    response_type: responseType,
    priority: normalizePriority(form.priority),
    status: form.status,
    due_date: form.dueDate || null,
    assigned_to: null,
    visible: true,
  };
}

export default function ClientDocuments() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const assignedCompanies = useMemo(() => (
    user?.assignedCompanies?.length
      ? user.assignedCompanies
      : [{ id: user?.company_id || user?.companyId, name: user?.company }].filter((company) => company.id)
  ), [user?.assignedCompanies, user?.company_id, user?.companyId, user?.company]);

  const [selectedCompanyId, setSelectedCompanyId] = useState(assignedCompanies[0]?.id || null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [isNewRequestOpen, setIsNewRequestOpen] = useState(false);
  const [folderOptions, setFolderOptions] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const dropdownRef = useRef(null);
  
  const companyId = selectedCompanyId || user?.company_id || user?.companyId || null;
  const fileExplorerRole = user?.role === 'user' ? 'user' : 'client';
  const canCreateRequest = user?.role === 'user';

  const filteredCompanies = assignedCompanies.filter((company) =>
    company.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const selectedCompany = assignedCompanies.find(c => c.id === selectedCompanyId);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (!canCreateRequest || !companyId) {
      setFolderOptions([]);
      return;
    }

    setFoldersLoading(true);
    listFolderTree(companyId)
      .then((tree) => {
        setFolderOptions(buildFolderOptionsFromTree(tree));
      })
      .catch(() => setFolderOptions([]))
      .finally(() => setFoldersLoading(false));
  }, [canCreateRequest, companyId]);

  const createRequest = async (form) => {
    if (!companyId) return;

    try {
      await createCompanyRequestItem(companyId, {
        ...buildCreateRequestPayload(form),
        created_by: user?.id || null,
      });
      setIsNewRequestOpen(false);
      showToast({
        type: 'success',
        title: 'Request created',
        message: 'Your request has been submitted for the selected company.',
      });
    } catch (err) {
      showToast({
        type: 'error',
        title: 'Unable to create request',
        message: err.message || 'Please try again.',
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Documents</h1>
          <p className="text-sm text-[#6D6E71] mt-0.5">Access files and documents shared with you</p>
        </div>
        {canCreateRequest && (
          <button
            type="button"
            onClick={() => setIsNewRequestOpen(true)}
            disabled={!companyId}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs sm:text-sm font-semibold shadow-md transition-all duration-200 ${
              companyId
                ? 'bg-[#8BC53D] text-white hover:bg-[#476E2C] hover:scale-[1.02]'
                : 'cursor-not-allowed bg-gray-200 text-[#A5A5A5] shadow-none'
            }`}
          >
            <Send size={15} />
            New Request
          </button>
        )}
      </div>

      {/* Company Selector */}
      {assignedCompanies.length > 0 && (
        <div className="bg-white rounded-2xl shadow-card p-5">
          <label className="block text-sm font-semibold text-[#050505] mb-3">Select Company</label>
          <div className="relative" ref={dropdownRef}>
            {/* Dropdown Trigger */}
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

            {/* Dropdown Menu */}
            {isOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-200 rounded-xl shadow-lg z-10 max-h-60 overflow-y-auto">
                {/* Search Input */}
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

                {/* Company Options */}
                <div>
                  {filteredCompanies.length > 0 ? (
                    filteredCompanies.map((company) => (
                      <button
                        key={company.id}
                        onClick={() => {
                          setSelectedCompanyId(company.id);
                          setSearchQuery('');
                          setIsOpen(false);
                        }}
                        className={`w-full text-left px-4 py-3 text-sm transition-colors hover:bg-[#E6F3D3] ${
                          selectedCompanyId === company.id
                            ? 'bg-[#E6F3D3] text-[#8BC53D] font-semibold'
                            : 'text-[#050505] hover:text-[#8BC53D]'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {selectedCompanyId === company.id && (
                            <svg className="w-4 h-4 text-[#8BC53D]" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          )}
                          <span>{company.name}</span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="px-4 py-6 text-center text-xs text-[#A5A5A5]">
                      No companies found
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* File Explorer */}
      {companyId && (
        <div className="-m-4 lg:-m-6 h-[calc(100vh-18rem)]">
          <FileExplorer
            role={fileExplorerRole}
            companyId={companyId}
            currentUserId={user?.id}
            title={`Documents - ${selectedCompany?.name || 'Documents'}`}
          />
        </div>
      )}

      {/* No Company Selected */}
      {!companyId && assignedCompanies.length === 0 && (
        <div className="bg-white rounded-2xl shadow-card p-8 text-center">
          <p className="text-sm text-[#A5A5A5]">
            No companies assigned. Please contact your administrator to get access.
          </p>
        </div>
      )}

      <NewRequestModal
        isOpen={canCreateRequest && isNewRequestOpen}
        onClose={() => setIsNewRequestOpen(false)}
        onCreate={createRequest}
        folderOptions={folderOptions}
        foldersLoading={foldersLoading}
      />
    </div>
  );
}
