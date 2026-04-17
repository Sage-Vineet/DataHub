import { useEffect, useMemo, useState } from 'react';
import { Plus, Search, Filter, Send, Clock, ChevronDown } from 'lucide-react';
import { requests as initRequests, companies, priorityOptions } from '../../data/mockData';
import StatusBadge from '../../components/common/StatusBadge';
import Modal from '../../components/common/Modal';
import NewRequestModal from '../../components/NewRequestModal';
import { listFolderTree } from '../../lib/api';
import { buildFolderOptionsFromTree } from '../../lib/folderOptions';

const STATUS_FILTERS = ['all', 'pending', 'received', 'under-review', 'approved', 'rejected'];

export default function BrokerRequests() {
  const [requests, setRequests] = useState(initRequests);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [companyFilter, setCompanyFilter] = useState('all');
  const [folderOptions, setFolderOptions] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);
  const openCreate = () => { setShowCreate(true); };
  const closeCreate = () => { setShowCreate(false); };

  const selectedCompanyId = useMemo(
    () => (companyFilter !== 'all' ? companyFilter : (companies[0]?.id ?? '')),
    [companyFilter]
  );

  useEffect(() => {
    if (!selectedCompanyId) {
      setFolderOptions([]);
      return;
    }

    setFoldersLoading(true);
    listFolderTree(selectedCompanyId)
      .then((tree) => {
        setFolderOptions(buildFolderOptionsFromTree(tree));
      })
      .catch(() => setFolderOptions([]))
      .finally(() => setFoldersLoading(false));
  }, [selectedCompanyId]);

  const filtered = requests.filter(r => {
    const q = search.toLowerCase();
    const matchQ = r.name.toLowerCase().includes(q) || r.companyName.toLowerCase().includes(q) || r.type.toLowerCase().includes(q);
    const matchS = statusFilter === 'all' || r.status === statusFilter;
    const matchP = priorityFilter === 'all' || r.priority === priorityFilter;
    const matchC = companyFilter === 'all' || r.companyId === companyFilter;
    return matchQ && matchS && matchP && matchC;
  });

  const handleCreate = (form) => {
    const co = companies.find(c => c.id === selectedCompanyId);
    if (!co || !form.name) return;
    const statusMap = { pending: 'pending', 'in-review': 'under-review', completed: 'approved' };
    const newReq = {
      id: `req${Date.now()}`,
      companyId: co.id,
      name: form.name,
      type: form.category,
      priority: form.priority,
      dueDate: form.dueDate || new Date().toISOString().slice(0, 10),
      notes: form.description || '',
      companyName: co.name,
      status: statusMap[form.status] ?? 'pending',
      createdAt: new Date().toISOString().slice(0, 10),
      documents: form.file ? [form.file.name] : [],
    };
    setRequests(r => [newReq, ...r]);
    setShowCreate(false);
  };
  const statusCounts = {
    all: requests.length,
    pending: requests.filter(r => r.status === 'pending').length,
    received: requests.filter(r => r.status === 'received').length,
    'under-review': requests.filter(r => r.status === 'under-review').length,
    approved: requests.filter(r => r.status === 'approved').length,
    rejected: requests.filter(r => r.status === 'rejected').length,
  };

  return (
    <div className="space-y-6">
      <NewRequestModal
        isOpen={showCreate}
        onClose={closeCreate}
        onCreate={handleCreate}
        folderOptions={folderOptions}
        foldersLoading={foldersLoading}
      />
      <Modal isOpen={!!selected} onClose={() => setSelected(null)} title="Request Details" size="md">
        {selected && (
          <div className="space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-bold text-[#050505]">{selected.name}</h3>
                <p className="text-xs text-[#A5A5A5] mt-0.5">{selected.id}</p>
              </div>
              <StatusBadge value={selected.status} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Company', value: selected.companyName },
                { label: 'Type', value: selected.type },
                { label: 'Priority', value: selected.priority },
                { label: 'Created', value: selected.createdAt },
                { label: 'Due Date', value: selected.dueDate },
                { label: 'Documents', value: `${selected.documents.length} received` },
              ].map(item => (
                <div key={item.label} className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-[#A5A5A5] mb-0.5">{item.label}</p>
                  <p className="text-sm font-semibold text-[#050505]">{item.value}</p>
                </div>
              ))}
            </div>
            {selected.notes && (
              <div className="bg-[#C9E4A4]/30 rounded-xl p-4 border border-[#8BC53D]/20">
                <p className="text-xs font-semibold text-[#476E2C] mb-1">Instructions</p>
                <p className="text-sm text-[#6D6E71]">{selected.notes}</p>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}



