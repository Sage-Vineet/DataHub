import { useEffect, useState } from 'react';
import StatusBadge from '../../components/common/StatusBadge';
import Modal from '../../components/common/Modal';
import NewRequestModal from '../../components/NewRequestModal';
import { listFolderTree, listCompaniesRequest } from '../../lib/api';
import { buildFolderOptionsFromTree } from '../../lib/folderOptions';

export default function BrokerRequests() {
  const [companies, setCompanies] = useState([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState(null);
  const [folderOptions, setFolderOptions] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);
  
  const openCreate = () => { setShowCreate(true); };
  const closeCreate = () => { setShowCreate(false); };

  useEffect(() => {
    let cancelled = false;
    listCompaniesRequest()
      .then((payload) => {
        if (cancelled) return;
        const list = Array.isArray(payload) ? payload : [];
        setCompanies(list);
        if (list.length > 0 && !selectedCompanyId) {
          setSelectedCompanyId(list[0].id);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedCompanyId]);

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

  const handleCreate = (form) => {
    // Currently no UI for listing requests, so just close the modal
    setShowCreate(false);
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



